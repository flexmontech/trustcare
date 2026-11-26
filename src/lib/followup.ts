/**
 * Trust Care Agency — follow-up workflow logic (server-side only, pure functions).
 *
 * Cadence: Day 0 initial outreach → Day 3 first follow-up → Day 7 second
 * follow-up → Day 14 final touch. The Day numbers are offsets from the FIRST
 * contact date, so a lead contacted on 2026-10-18 is due 10-21, 10-25, 11-01.
 * After the final step the lead rests unless the agency re-engages it manually.
 *
 * THIS MODULE IS THE SINGLE SOURCE OF TRUTH for "what is this lead's next
 * date". Everything else (the contact-log API, manual status/response edits in
 * src/lib/leads.ts, the dashboard queue, the leads table) calls into it:
 *
 *   resolveFollowUpSchedule()  given a lead's fields → is the cadence stopped /
 *                              complete, which step is next, and the next date
 *   planContactLog()           one tap "I called / I emailed" → the exact
 *                              fields to store (dates, count, status, note)
 *   getFollowUpState()         human-facing state for the UI (labels, "due now")
 *
 * Stored fields it reads:
 *   - follow_up_count      how many touches have been logged (0 = not yet contacted)
 *   - first_contact_date   Day 0 — the cadence anchor (set on the first log)
 *   - last_contact_date    when the most recent touch happened (YYYY-MM-DD)
 *   - next_follow_up_date  the scheduled next touch (cleared when stopped/complete)
 *
 * Response classification (stored on the lead, set via the contact log or PATCH):
 *   Interested | Needs Staffing | Not Interested | No Response | Do Not Contact
 * Interested / Needs Staffing / No Response keep the cadence going.
 * Not Interested and Do Not Contact are TERMINAL: no further date is scheduled
 * and the lead drops out of the dashboard's due queue. "Converted" and a lead
 * status of "Do Not Contact" also stop the cadence.
 */

export const FOLLOW_UP_INTERVALS = [0, 3, 7, 14] as const;

export const RESPONSE_CLASSIFICATIONS = [
  "Interested",
  "Needs Staffing",
  "Not Interested",
  "No Response",
  "Do Not Contact",
] as const;

export type ResponseClassification = (typeof RESPONSE_CLASSIFICATIONS)[number];

export function isResponseClassification(
  value: unknown,
): value is ResponseClassification {
  return (
    typeof value === "string" &&
    (RESPONSE_CLASSIFICATIONS as readonly string[]).includes(value.trim())
  );
}

const TERMINAL_CLASSIFICATIONS: ReadonlySet<string> = new Set([
  "Not Interested",
  "Do Not Contact",
]);

const MS_PER_DAY = 86_400_000;

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(dateOnly: string, days: number): string {
  const d = new Date(`${dateOnly}T00:00:00Z`);
  return toDateOnly(new Date(d.getTime() + days * MS_PER_DAY));
}

/** Today in YYYY-MM-DD (UTC). Injectable date keeps this unit-testable. */
export function todayOnly(now: Date = new Date()): string {
  return toDateOnly(now);
}

/** A trimmed YYYY-MM-DD string, or null when the value isn't a date. */
export function dateOnlyOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

export interface FollowUpInput {
  follow_up_count?: number | null;
  first_contact_date?: string | null;
  last_contact_date?: string | null;
  next_follow_up_date?: string | null;
  lead_status?: string | null;
  response_classification?: string | null;
}

const STEP_LABELS = [
  "Initial outreach",
  "First follow-up",
  "Second follow-up",
  "Final touch",
] as const;

/**
 * Why this lead's cadence is stopped, in plain words — or null when follow-ups
 * are still appropriate. Terminal classifications and Do-Not-Contact/Converted
 * statuses stop it; they also clear any scheduled date.
 */
export function cadenceStopReason(input: {
  lead_status?: string | null;
  response_classification?: string | null;
}): string | null {
  const classification = (input.response_classification ?? "").trim();
  const status = (input.lead_status ?? "").trim();
  if (TERMINAL_CLASSIFICATIONS.has(classification))
    return classification === "Do Not Contact"
      ? "marked Do Not Contact"
      : "marked Not Interested";
  if (status === "Do Not Contact") return "marked Do Not Contact";
  if (status === "Converted") return "already converted";
  return null;
}

export interface FollowUpSchedule {
  /** Has anyone actually been contacted yet (count/logged date present)? */
  contacted: boolean;
  /** Terminal: no follow-up, ever (Not Interested / Do Not Contact / Converted). */
  isTerminal: boolean;
  /** All four cadence steps are logged. */
  isComplete: boolean;
  /** Index of the NEXT step to perform (0-based, clamped to the last step). */
  stepIndex: number;
  stepLabel: string;
  stepDay: number;
  /** The Day-0 date the cadence counts from. */
  anchorDate: string | null;
  /** The date the next touch is due, or null when nothing is scheduled. */
  nextDueDate: string | null;
  /** Plain-words reason when the cadence is stopped. */
  stopReason: string | null;
}

/**
 * THE scheduling rule. Given a lead's stored fields, return the next date.
 *
 * - Stopped (terminal / Converted / Do Not Contact) → nextDueDate null, isTerminal true.
 * - All four steps logged → nextDueDate null, isComplete true.
 * - An explicitly stored next_follow_up_date → that date (staff override wins).
 * - Never contacted → nextDueDate null (nothing to schedule until Day 0 is logged).
 * - Otherwise → first_contact_date + the Day offset of the next step.
 *
 * `strictFuture` is used when logging a contact: a next date that would land on
 * or before today (someone logged a touch late) is moved to the normal gap
 * after today instead, so the schedule never holds a past or same-day date.
 */
export function resolveFollowUpSchedule(
  input: FollowUpInput,
  now: Date = new Date(),
  opts: { strictFuture?: boolean } = {},
): FollowUpSchedule {
  const today = todayOnly(now);
  const count = Math.max(0, Math.floor(Number(input.follow_up_count ?? 0) || 0));
  const stepIndex = Math.min(count, FOLLOW_UP_INTERVALS.length - 1);
  const stepLabel = STEP_LABELS[stepIndex];
  const stepDay = FOLLOW_UP_INTERVALS[stepIndex];
  const stopReason = cadenceStopReason(input);
  const firstContact =
    dateOnlyOrNull(input.first_contact_date) ?? dateOnlyOrNull(input.last_contact_date);
  const contacted =
    count > 0 || dateOnlyOrNull(input.last_contact_date) !== null;

  const base = {
    contacted,
    stepIndex,
    stepLabel,
    stepDay,
    anchorDate: firstContact,
    stopReason,
  };

  if (stopReason !== null)
    return { ...base, isTerminal: true, isComplete: true, nextDueDate: null };

  if (count >= FOLLOW_UP_INTERVALS.length)
    return { ...base, isTerminal: false, isComplete: true, nextDueDate: null };

  const explicit = dateOnlyOrNull(input.next_follow_up_date);
  if (explicit !== null)
    return { ...base, isTerminal: false, isComplete: false, nextDueDate: explicit };

  if (!contacted)
    return { ...base, isTerminal: false, isComplete: false, nextDueDate: null };

  const anchor = firstContact ?? today;
  let nextDueDate = addDays(anchor, FOLLOW_UP_INTERVALS[stepIndex]);
  if (opts.strictFuture && nextDueDate <= today) {
    const gap = Math.max(
      1,
      FOLLOW_UP_INTERVALS[stepIndex] -
        FOLLOW_UP_INTERVALS[Math.max(0, stepIndex - 1)],
    );
    nextDueDate = addDays(today, gap);
  }
  return { ...base, isTerminal: false, isComplete: false, nextDueDate };
}

export interface FollowUpState {
  /** 0-based step: 0 = initial (Day 0) … 3 = final (Day 14). */
  stepIndex: number;
  /** Human label for the current step. */
  stepLabel: string;
  /** Day offset of the current step within the cadence. */
  stepDay: number;
  /** Whether the current step is the last in the cadence. */
  isFinalStep: boolean;
  /** Cadence is over (final touch logged) or terminally classified. */
  isComplete: boolean;
  /** The date the next touch is due (explicit override wins). */
  nextDueDate: string | null;
  /** True when the lead is due (or overdue) as of `now`. */
  isDue: boolean;
  /** What the agency should do next — plain language for the dashboard. */
  nextAction: string;
}

/** Human-facing view of the schedule (labels + "due now") for the UI. */
export function getFollowUpState(
  input: FollowUpInput,
  now: Date = new Date(),
): FollowUpState {
  const schedule = resolveFollowUpSchedule(input, now);
  const today = todayOnly(now);
  const { stepIndex, stepLabel, stepDay } = schedule;
  const isFinalStep = stepIndex === FOLLOW_UP_INTERVALS.length - 1;

  if (schedule.stopReason !== null) {
    return {
      stepIndex,
      stepLabel,
      stepDay,
      isFinalStep: true,
      isComplete: true,
      nextDueDate: null,
      isDue: false,
      nextAction: `No further follow-up — lead is ${schedule.stopReason}.`,
    };
  }

  if (schedule.isComplete) {
    return {
      stepIndex,
      stepLabel,
      stepDay,
      isFinalStep: true,
      isComplete: true,
      nextDueDate: null,
      isDue: false,
      nextAction:
        "Cadence complete — re-engage manually only if something changes.",
    };
  }

  // Never contacted: the Day 0 touch is the thing to do, so show it as due now
  // (the dashboard queue stays driven by a real stored next_follow_up_date).
  if (!schedule.contacted) {
    return {
      stepIndex,
      stepLabel,
      stepDay,
      isFinalStep,
      isComplete: false,
      nextDueDate: today,
      isDue: true,
      nextAction:
        "Not contacted yet — log the Day 0 initial outreach to start the cadence.",
    };
  }

  const nextDueDate = schedule.nextDueDate;
  const isDue = nextDueDate !== null && nextDueDate <= today;
  const nextAction = isDue
    ? `Due now: send the "${stepLabel}" (Day ${String(stepDay)}) touch.`
    : nextDueDate
      ? `Scheduled: "${stepLabel}" (Day ${String(stepDay)}) due ${nextDueDate}.`
      : `Next: log the "${stepLabel}" (Day ${String(stepDay)}) touch to keep the cadence moving.`;

  return {
    stepIndex,
    stepLabel,
    stepDay,
    isFinalStep,
    isComplete: false,
    nextDueDate,
    isDue,
    nextAction,
  };
}

/* -------------------------------------------------------------------------- */
/*  Contact logging ("I called", "I emailed", "In person / other")            */
/* -------------------------------------------------------------------------- */

export const CONTACT_CHANNELS = [
  "Phone call",
  "Email",
  "In person / other",
] as const;

export type ContactChannel = (typeof CONTACT_CHANNELS)[number];

/**
 * Accept the three canonical channels plus the loose words staff actually send
 * ("call", "called", "emailed", "visit", …). Returns null when unrecognised.
 */
export function normalizeContactChannel(value: unknown): ContactChannel | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (v === "") return null;
  const match = CONTACT_CHANNELS.find((c) => c.toLowerCase() === v);
  if (match) return match;
  if (/^(phone|phone call|call|called|rang|voicemail)$/.test(v)) return "Phone call";
  if (/^(e-?mail|e-?mailed|sent|sent email)$/.test(v)) return "Email";
  if (/^(other|in person|in-person|in person \/ other|visit|visited|in office)$/.test(v))
    return "In person / other";
  return null;
}

/** Max length of the stored notes field (matches the store's per-field cap). */
const NOTES_MAX = 2000;

/**
 * Append a dated contact line to the lead's notes, keeping the NEWEST entry
 * when the field is full (the store truncates long text from the end).
 */
function appendContactNote(
  existing: string | null | undefined,
  line: string,
): string {
  const previous = (existing ?? "").trim();
  const combined = previous === "" ? line : `${previous}\n${line}`;
  if (combined.length <= NOTES_MAX) return combined;
  if (line.length >= NOTES_MAX) return line.slice(0, NOTES_MAX);
  const room = NOTES_MAX - line.length - 2; // 2 for the ellipsis + newline
  const kept = previous.slice(Math.max(0, previous.length - room));
  return `…${kept}\n${line}`;
}

export interface ContactLogPlan {
  first_contact_date: string;
  last_contact_date: string;
  follow_up_count: number;
  next_follow_up_date: string | null;
  lead_status: string;
  notes: string | null;
  /** Post-log schedule, for the API response and the UI's confirmation. */
  schedule: FollowUpSchedule;
}

/** Statuses that are further along than "Contacted" and must not be reset. */
const PROGRESS_STATUSES: ReadonlySet<string> = new Set([
  "Interested",
  "Appointment",
  "Converted",
  "Do Not Contact",
]);

/**
 * ONE action: "I contacted this lead by <channel>", optionally with a note.
 * Returns the exact fields to store:
 *   last_contact_date   = today
 *   first_contact_date  = today on the first touch, unchanged afterwards (anchor)
 *   follow_up_count     = previous + 1
 *   next_follow_up_date = Day-0 anchor + the next step's offset (never in the
 *                         past); null when the lead is terminal or the cadence
 *                         is complete
 *   lead_status         = "Contacted" (kept if it is already further along)
 *   notes               = existing notes + a dated "channel — note" line
 *
 * Callers persist the result through the lead store; nothing here writes.
 */
export function planContactLog(
  input: FollowUpInput & { notes?: string | null },
  opts: { channel: ContactChannel; note?: string | null; on?: Date },
): ContactLogPlan {
  const now = opts.on ?? new Date();
  const today = todayOnly(now);

  const firstContact =
    dateOnlyOrNull(input.first_contact_date) ??
    dateOnlyOrNull(input.last_contact_date) ??
    today;
  const follow_up_count =
    Math.max(0, Math.floor(Number(input.follow_up_count ?? 0) || 0)) + 1;

  const currentStatus = (input.lead_status ?? "").trim();
  const lead_status = PROGRESS_STATUSES.has(currentStatus)
    ? currentStatus
    : "Contacted";

  const schedule = resolveFollowUpSchedule(
    {
      follow_up_count,
      first_contact_date: firstContact,
      last_contact_date: today,
      next_follow_up_date: null,
      lead_status,
      response_classification: input.response_classification ?? null,
    },
    now,
    { strictFuture: true },
  );

  const note = (opts.note ?? "").trim().slice(0, 500);
  const line = note === "" ? `${today} · ${opts.channel}` : `${today} · ${opts.channel} — ${note}`;

  return {
    first_contact_date: firstContact,
    last_contact_date: today,
    follow_up_count,
    next_follow_up_date: schedule.nextDueDate,
    lead_status,
    notes: appendContactNote(input.notes, line),
    schedule,
  };
}
