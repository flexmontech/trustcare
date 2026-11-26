import {
  RESPONSE_CLASSIFICATIONS,
  normalizeContactChannel,
  planContactLog,
  resolveFollowUpSchedule,
} from "./followup";
import type { ContactChannel, FollowUpSchedule } from "./followup";
import { getLead, updateLeadRecord } from "./store";
import type { LeadRecord } from "./store";

/**
 * Shared server-only helpers for the leads API routes
 * (src/routes/api.leads.ts, src/routes/api.outreach.ts).
 * Only ever called inside server handlers — never from client code.
 *
 * $0 local store: persistence lives in src/lib/store.ts (JSON file on disk).
 * Nothing here touches a database; nothing requires DATABASE_URL or Neon.
 */

/** All CSV-backed columns of a lead (everything except id/timestamps). */
export const LEAD_FIELDS = [
  "company_name",
  "address",
  "city",
  "state",
  "zip",
  "website",
  "contact_name",
  "contact_role",
  "email",
  "phone",
  "lead_type",
  "lead_status",
  "lead_score",
  "score_tier",
  "response_classification",
  "first_contact_date",
  "last_contact_date",
  "next_follow_up_date",
  "follow_up_count",
  "notes",
] as const;

export type LeadField = (typeof LEAD_FIELDS)[number];

/** Throw this for 400s; handlers translate it (anything else → 500). */
export class BadRequest extends Error {}

/** Throw this for 404s; handlers translate it. */
export class NotFound extends Error {}

export function badRequest(message: string): BadRequest {
  return new BadRequest(message);
}

/** Map a thrown error to an honest JSON response (no stack traces). */
export function errorResponse(err: unknown): Response {
  if (err instanceof BadRequest) {
    return Response.json({ error: err.message }, { status: 400 });
  }
  if (err instanceof NotFound) {
    return Response.json({ error: err.message }, { status: 404 });
  }
  const message = err instanceof Error ? err.message : String(err);
  return Response.json(
    { error: "Request failed", detail: message },
    { status: 500 },
  );
}

/** Alias kept so older imports keep working. */
export const dbErrorResponse = errorResponse;

/**
 * Coerce a store record to plain JSON-safe data (strings/numbers/null only).
 */
export function serializeLead(
  row: Record<string, unknown>,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined) out[key] = null;
    else if (value instanceof Date) out[key] = value.toISOString();
    else if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    )
      out[key] = value;
    else out[key] = String(value);
  }
  return out;
}

function emptyToNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

function parseOptionalInt(
  value: unknown,
  field: string,
  opts?: { min?: number },
): number | null {
  if (value === undefined || value === null || String(value).trim() === "")
    return null;
  const n = Number(value);
  if (!Number.isInteger(n)) throw badRequest(`${field} must be an integer`);
  if (opts?.min !== undefined && n < opts.min)
    throw badRequest(`${field} must be >= ${opts.min}`);
  return n;
}

function parseOptionalDate(value: unknown, field: string): string | null {
  if (value === undefined || value === null || String(value).trim() === "")
    return null;
  const s = String(value).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s))
    throw badRequest(`${field} must be a date in YYYY-MM-DD format`);
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw badRequest(`${field} is not a valid date`);
  return s;
}

export interface NormalizedLead {
  company_name: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  website: string | null;
  contact_name: string | null;
  contact_role: string | null;
  email: string | null;
  phone: string | null;
  lead_type: string | null;
  lead_status: string | null;
  lead_score: number | null;
  score_tier: string | null;
  response_classification: string | null;
  first_contact_date: string | null;
  last_contact_date: string | null;
  next_follow_up_date: string | null;
  follow_up_count: number | null;
  notes: string | null;
}

/**
 * Validate + normalize a POST/PATCH JSON body. For creates, company_name is
 * required, lead_status defaults to 'New', follow_up_count defaults to 0.
 * For updates every field is optional (callers must ensure ≥1 is present).
 *
 * Note: lead_score/score_tier are validated here but the store always
 * recomputes them from src/lib/scoring.ts on create/update, so the stored
 * score is never client-controlled.
 */
export function normalizeLeadInput(
  body: Record<string, unknown>,
  forCreate: boolean,
): NormalizedLead {
  const company_name = emptyToNull(body.company_name);
  if (forCreate && !company_name)
    throw badRequest("company_name is required");
  if (body.company_name !== undefined && body.company_name !== null) {
    const s = String(body.company_name).trim();
    if (s === "") throw badRequest("company_name must not be empty");
  }

  let lead_status = emptyToNull(body.lead_status);
  if (forCreate && !lead_status) lead_status = "New";
  if (body.lead_status !== undefined && body.lead_status !== null) {
    if (String(body.lead_status).trim() === "")
      throw badRequest("lead_status must not be empty");
  }

  let follow_up_count = parseOptionalInt(body.follow_up_count, "follow_up_count", {
    min: 0,
  });
  if (forCreate && follow_up_count === null) follow_up_count = 0;

  // Response classification: optional, but when present must be one of the
  // five follow-up workflow values (single source: src/lib/followup.ts).
  let response_classification = emptyToNull(body.response_classification);
  if (response_classification !== null) {
    const match = RESPONSE_CLASSIFICATIONS.find(
      (c) => c.toLowerCase() === response_classification!.toLowerCase(),
    );
    if (!match)
      throw badRequest(
        `response_classification must be one of: ${RESPONSE_CLASSIFICATIONS.join(", ")}`,
      );
    response_classification = match;
  }

  // score_tier is derived from lead_score (HOT 80–100 / WARM 50–79 / COLD 0–49).
  // Accept an explicit value but normalize its casing; otherwise derive it.
  const lead_score = parseOptionalInt(body.lead_score, "lead_score");
  let score_tier = emptyToNull(body.score_tier);
  if (score_tier !== null) {
    const upper = score_tier.toUpperCase();
    if (upper !== "HOT" && upper !== "WARM" && upper !== "COLD")
      throw badRequest("score_tier must be one of: HOT, WARM, COLD");
    score_tier = upper;
  } else if (lead_score !== null) {
    score_tier = lead_score >= 80 ? "HOT" : lead_score >= 50 ? "WARM" : "COLD";
  }

  return {
    company_name,
    address: emptyToNull(body.address),
    city: emptyToNull(body.city),
    state: emptyToNull(body.state),
    zip: emptyToNull(body.zip),
    website: emptyToNull(body.website),
    contact_name: emptyToNull(body.contact_name),
    contact_role: emptyToNull(body.contact_role),
    email: emptyToNull(body.email),
    phone: emptyToNull(body.phone),
    lead_type: emptyToNull(body.lead_type),
    lead_status,
    lead_score,
    score_tier,
    response_classification,
    first_contact_date: parseOptionalDate(
      body.first_contact_date,
      "first_contact_date",
    ),
    last_contact_date: parseOptionalDate(body.last_contact_date, "last_contact_date"),
    next_follow_up_date: parseOptionalDate(
      body.next_follow_up_date,
      "next_follow_up_date",
    ),
    follow_up_count,
    notes: emptyToNull(body.notes),
  };
}

/** Parse an :id path param; throws 400 unless it's a positive integer. */
export function parseLeadId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0)
    throw badRequest("Lead id must be a positive integer");
  return id;
}

/** Does the request body contain at least one known lead field? */
export function hasUpdatableField(body: Record<string, unknown>): boolean {
  return LEAD_FIELDS.some((f) => body[f] !== undefined);
}

/**
 * JSON-store-backed update used by PATCH /api/leads?id=. Only fields present
 * in `body` are touched; score/tier are recomputed by the store. Returns the
 * serialized updated lead; throws BadRequest (empty body) or NotFound.
 *
 * CADENCE RECONCILIATION: when an edit touches anything the follow-up engine
 * depends on (status, response classification, contact dates, follow-up count)
 * and the caller did not send an explicit next_follow_up_date, the next date is
 * recomputed by src/lib/followup.ts — the single source of truth. So marking a
 * lead Not Interested / Do Not Contact clears its date (terminal), while
 * Interested / Needs Staffing / No Response keep the cadence going.
 */
export function updateLead(
  id: number,
  body: Record<string, unknown>,
): Record<string, string | number | boolean | null> {
  if (!hasUpdatableField(body))
    throw badRequest("Request body must include at least one lead field");
  // Validate values (throws BadRequest on bad input). lead_score/score_tier in
  // the body are accepted but ignored — the store recomputes them.
  const normalized = normalizeLeadInput(body, false);
  const patch: Record<string, unknown> = {};
  for (const field of LEAD_FIELDS) {
    if (body[field] === undefined) continue;
    if (field === "lead_score" || field === "score_tier") continue;
    patch[field] = normalized[field];
  }
  if (Object.keys(patch).length === 0)
    throw badRequest("Request body must include at least one lead field");
  const existing = getLead(id);
  if (!existing) throw new NotFound("Lead not found");

  const CADENCE_FIELDS = [
    "lead_status",
    "response_classification",
    "first_contact_date",
    "last_contact_date",
    "follow_up_count",
  ];
  if (
    body.next_follow_up_date === undefined &&
    CADENCE_FIELDS.some((f) => body[f] !== undefined)
  ) {
    const merged = { ...existing } as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) merged[key] = value;
    // The stored date is what we are recomputing — never feed it back in as an
    // explicit override, or nothing would ever change.
    merged.next_follow_up_date = null;
    patch.next_follow_up_date = resolveFollowUpSchedule(merged).nextDueDate;
  }

  const updated = updateLeadRecord(id, patch);
  if (!updated) throw new NotFound("Lead not found");
  return serializeLead(updated as unknown as Record<string, unknown>);
}

/* -------------------------------------------------------------------------- */
/*  Contact logging — the one action staff use most                            */
/* -------------------------------------------------------------------------- */

export interface LogContactResult {
  lead: Record<string, string | number | boolean | null>;
  /** What the follow-up engine decided, for the UI's confirmation line. */
  followUp: {
    next_follow_up_date: string | null;
    last_contact_date: string;
    follow_up_count: number;
    stepLabel: string;
    stepDay: number;
    isTerminal: boolean;
    isComplete: boolean;
    stopsCadenceReason: string | null;
    nextAction: string;
  };
}

/**
 * POST /api/leads/contact?id=123  { channel: "Phone call" | "Email" |
 * "In person / other", note?: string }
 *
 * Logging a contact in ONE step (see planContactLog in src/lib/followup.ts):
 *   last_contact_date   = today
 *   follow_up_count     = +1
 *   next_follow_up_date = Day 0 + the next cadence offset (null when terminal
 *                         or complete; never a past / same-day date)
 *   lead_status         = Contacted
 *   notes               = existing + a dated "channel — note" line
 * The lead's response classification is left exactly as staff recorded it, and
 * it decides whether follow-ups continue (Interested / Needs Staffing / No
 * Response) or stop (Not Interested / Do Not Contact).
 */
export function logContact(
  id: number,
  body: Record<string, unknown>,
): LogContactResult {
  const existing = getLead(id);
  if (!existing) throw new NotFound("Lead not found");

  const channel: ContactChannel | null = normalizeContactChannel(
    body.channel ?? body.contact_channel ?? body.method,
  );
  if (channel === null)
    throw badRequest(
      "channel is required: one of Phone call, Email, In person / other",
    );

  const rawNote = body.note ?? body.contact_note;
  if (rawNote !== undefined && rawNote !== null && typeof rawNote !== "string" && typeof rawNote !== "number")
    throw badRequest("note must be text");

  const plan = planContactLog(existing as LeadRecord, {
    channel,
    note: rawNote === undefined || rawNote === null ? null : String(rawNote),
  });

  const updated = updateLeadRecord(id, {
    first_contact_date: plan.first_contact_date,
    last_contact_date: plan.last_contact_date,
    follow_up_count: plan.follow_up_count,
    next_follow_up_date: plan.next_follow_up_date,
    lead_status: plan.lead_status,
    notes: plan.notes,
  });
  if (!updated) throw new NotFound("Lead not found");

  const schedule: FollowUpSchedule = resolveFollowUpSchedule(updated);
  return {
    lead: serializeLead(updated as unknown as Record<string, unknown>),
    followUp: {
      next_follow_up_date: schedule.nextDueDate,
      last_contact_date: plan.last_contact_date,
      follow_up_count: plan.follow_up_count,
      stepLabel: schedule.stepLabel,
      stepDay: schedule.stepDay,
      isTerminal: schedule.isTerminal,
      isComplete: schedule.isComplete,
      stopsCadenceReason: schedule.stopReason,
      nextAction: getNextAction(schedule),
    },
  };
}

/** Plain-words summary of a schedule for the confirmation line. */
function getNextAction(schedule: FollowUpSchedule): string {
  if (schedule.stopReason !== null)
    return `No further follow-up — lead is ${schedule.stopReason}.`;
  if (schedule.isComplete)
    return "Cadence complete — all four touches are logged.";
  if (schedule.nextDueDate === null) return "No follow-up scheduled.";
  return `Next: ${schedule.stepLabel} (Day ${String(schedule.stepDay)}) on ${schedule.nextDueDate}.`;
}
