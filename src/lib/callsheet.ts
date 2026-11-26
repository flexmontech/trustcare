/**
 * Trust Care Agency — TODAY'S CALL SHEET selection (pure functions, no I/O).
 *
 * The /calls page asks one question: "who am I phoning today?". This module
 * answers it from the stored lead fields and nothing else — the same fields the
 * dashboard and /leads already read. It does NOT write, score or schedule
 * anything:
 *
 *   - terminal leads are excluded using the shared cadence rule
 *     (src/lib/followup.ts → cadenceStopReason), never a second copy of it;
 *   - a lead whose last contact is today is off the sheet, so the batch shrinks
 *     as the team works down it (real data, so it survives a reload);
 *   - ordering: a REAL stored next_follow_up_date on/before today comes first,
 *     soonest/most overdue first (the same definition as the dashboard's due
 *     queue), then everything else by score descending;
 *   - the list is paged in batches of CALL_BATCH_SIZE (12) — a number of calls
 *     a person can actually finish.
 *
 * Everything the /calls page displays about state comes from
 * getFollowUpState(), and every count is derived from stored leads.
 */

import { cadenceStopReason, getFollowUpState } from "./followup";
import type { FollowUpState } from "./followup";

/** The lead fields the call sheet needs — a subset of the store's record. */
export interface CallLead {
  id: number;
  company_name: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
  contact_name: string | null;
  contact_role: string | null;
  lead_type: string | null;
  lead_status: string | null;
  lead_score: number | null;
  score_tier: string | null;
  response_classification: string | null;
  follow_up_count: number | null;
  first_contact_date: string | null;
  last_contact_date: string | null;
  next_follow_up_date: string | null;
}

/** 12 calls a batch — the size the page pages by. */
export const CALL_BATCH_SIZE = 12;

export type CallEmailFilter = "phone" | "email" | null;

/** Generic over the lead shape so callers keep their extra fields (website). */
export interface CallEntry<T extends CallLead = CallLead> {
  lead: T;
  state: FollowUpState;
}

export interface CallSheetSelection<T extends CallLead = CallLead> {
  /** Non-terminal, not called today, cadence not finished. */
  pool: CallEntry<T>[];
  /** Chip counts over the whole pool (independent of the active filters). */
  counts: { phoneOnly: number; email: number; named: number };
  /** The filtered, ordered list. */
  ordered: CallEntry<T>[];
  /** The 12 (or fewer) calls on the current page. */
  batch: CallEntry<T>[];
  /** Clamped page index actually in use. */
  page: number;
  pageCount: number;
  /** 1-based position of the first / last row in `batch` (0 when empty). */
  rangeStart: number;
  rangeEnd: number;
}

export function leadHasEmail(lead: { email: string | null }): boolean {
  return (lead.email ?? "").trim() !== "";
}

export function leadHasNamedContact(lead: {
  contact_name: string | null;
}): boolean {
  return (lead.contact_name ?? "").trim() !== "";
}

/** A UTC-midnight Date for a YYYY-MM-DD string — matches the server's clock. */
export function dateOnlyToDate(dateOnly: string): Date {
  return new Date(`${dateOnly}T00:00:00Z`);
}

/** The fields src/lib/followup.ts reads off a lead. */
export function followUpInput(lead: CallLead) {
  return {
    follow_up_count: lead.follow_up_count ?? 0,
    first_contact_date: lead.first_contact_date,
    last_contact_date: lead.last_contact_date,
    next_follow_up_date: lead.next_follow_up_date,
    lead_status: lead.lead_status,
    response_classification: lead.response_classification,
  };
}

/**
 * Leads a human can usefully phone right now: not terminal, not already called
 * today, and cadence not finished (four touches logged = nothing to do).
 */
export function buildCallPool<T extends CallLead>(
  leads: T[],
  today: string,
  now: Date = dateOnlyToDate(today),
): CallEntry<T>[] {
  return leads
    .filter(
      (lead) =>
        cadenceStopReason(lead) === null && lead.last_contact_date !== today,
    )
    .map((lead) => ({ lead, state: getFollowUpState(followUpInput(lead), now) }))
    .filter(({ state }) => !state.isComplete);
}

/**
 * A stored due date on/before today — the dashboard's queue rule, reused.
 * Never-contacted leads have no stored date, so they sort by score instead of
 * pretending to be overdue.
 */
function dueKey(lead: CallLead, today: string): string | null {
  return lead.next_follow_up_date !== null &&
    lead.next_follow_up_date <= today
    ? lead.next_follow_up_date
    : null;
}

/** Due/overdue first (soonest first), then by score descending. */
export function orderCalls<T extends CallLead>(
  entries: CallEntry<T>[],
  today: string,
): CallEntry<T>[] {
  return [...entries].sort((a, b) => {
    const da = dueKey(a.lead, today);
    const db = dueKey(b.lead, today);
    if (da !== null && db !== null) {
      const byDate = da.localeCompare(db);
      if (byDate !== 0) return byDate;
    } else if (da !== null) return -1;
    else if (db !== null) return 1;
    return (
      (b.lead.lead_score ?? 0) - (a.lead.lead_score ?? 0) ||
      (a.lead.company_name ?? "").localeCompare(b.lead.company_name ?? "")
    );
  });
}

/** Chips: phone-only / has email / named contact — over the whole pool. */
export function countCalls(pool: CallEntry[]) {
  return {
    phoneOnly: pool.filter(({ lead }) => !leadHasEmail(lead)).length,
    email: pool.filter(({ lead }) => leadHasEmail(lead)).length,
    named: pool.filter(({ lead }) => leadHasNamedContact(lead)).length,
  };
}

export interface CallSheetOptions {
  today: string;
  emailFilter?: CallEmailFilter;
  namedOnly?: boolean;
  /** Requested page index (clamped to the real page count). */
  page?: number;
  batchSize?: number;
  now?: Date;
}

/**
 * The whole view in one call: pool → counts → filtered → ordered → one batch.
 * Filters compose with paging; changing a filter resets the page in the UI.
 */
export function selectCalls<T extends CallLead>(
  leads: T[],
  opts: CallSheetOptions,
): CallSheetSelection<T> {
  const batchSize = opts.batchSize ?? CALL_BATCH_SIZE;
  const emailFilter = opts.emailFilter ?? null;
  const namedOnly = opts.namedOnly ?? false;
  const pool = buildCallPool(
    leads,
    opts.today,
    opts.now ?? dateOnlyToDate(opts.today),
  );
  const counts = countCalls(pool);

  const filtered = pool.filter(({ lead }) => {
    if (emailFilter === "phone" && leadHasEmail(lead)) return false;
    if (emailFilter === "email" && !leadHasEmail(lead)) return false;
    if (namedOnly && !leadHasNamedContact(lead)) return false;
    return true;
  });

  const ordered = orderCalls(filtered, opts.today);
  const pageCount = Math.max(1, Math.ceil(ordered.length / batchSize));
  const page = Math.min(
    Math.max(0, Math.floor(opts.page ?? 0)),
    pageCount - 1,
  );
  const batch = ordered.slice(page * batchSize, page * batchSize + batchSize);

  return {
    pool,
    counts,
    ordered,
    batch,
    page,
    pageCount,
    rangeStart: batch.length === 0 ? 0 : page * batchSize + 1,
    rangeEnd: page * batchSize + batch.length,
  };
}

/* -------------------------------------------------------------------------- */
/*  Plain-words state for a card                                              */
/* -------------------------------------------------------------------------- */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** "Tue" for 2026-10-27 — so "Called Tue" reads like a person wrote it. */
export function weekdayOf(dateOnly: string | null): string {
  if (dateOnly === null || dateOnly === "") return "";
  const d = dateOnlyToDate(dateOnly);
  return Number.isNaN(d.getTime()) ? "" : WEEKDAYS[d.getUTCDay()];
}

/**
 * The lead's state in plain words, built only from stored fields plus
 * getFollowUpState():
 *   "Not contacted yet"
 *   "Called Tue — No Response · Day 3 follow-up due"
 *   "Called Tue — Interested · next 2026-11-03"
 *   "No further follow-up — marked Do Not Contact"
 */
export function callStatusLine(lead: CallLead, state: FollowUpState): string {
  const stop = cadenceStopReason(lead);
  if (stop !== null) return `No further follow-up — ${stop}`;
  const neverContacted =
    (lead.follow_up_count ?? 0) === 0 && lead.last_contact_date === null;
  if (neverContacted) return "Not contacted yet";

  const day = weekdayOf(lead.last_contact_date);
  const response = (lead.response_classification ?? "").trim();
  let line = `Called${day === "" ? "" : ` ${day}`}`;
  if (response !== "") line = `${line} — ${response}`;
  if (state.isComplete) return `${line} · cadence complete`;
  if (state.isDue) return `${line} · Day ${String(state.stepDay)} follow-up due`;
  if (state.nextDueDate !== null) return `${line} · next ${state.nextDueDate}`;
  return line;
}
