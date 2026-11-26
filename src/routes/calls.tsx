import { Link, createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { CopyButton } from "~/components/copy-button";
import { TeamAccount } from "~/components/team-account";
import { isAuthenticatedRequest } from "~/lib/auth";
import {
  CALL_BATCH_SIZE,
  callStatusLine,
  dateOnlyToDate,
  selectCalls,
} from "~/lib/callsheet";
import type { CallLead } from "~/lib/callsheet";
import { cadenceStopReason, todayOnly } from "~/lib/followup";
import type { OutreachDrafts } from "~/lib/outreach";
import { scoreLead } from "~/lib/scoring";
import type { ScoreBreakdown } from "~/lib/scoring";
import { listLeads } from "~/lib/store";

/**
 * TODAY'S CALL SHEET — /calls
 *
 * "Who am I phoning today?" in one screen. This page is a work list over data
 * and endpoints that ALREADY EXIST:
 *
 *   - rows come from the same $0 JSON store as /leads and /dashboard
 *     (src/lib/store.ts → listLeads());
 *   - the terminal-lead rule and the plain-words status come from the shared
 *     cadence engine (src/lib/followup.ts → cadenceStopReason / getFollowUpState);
 *   - the "why this one" hint comes from the existing scorer's breakdown
 *     (src/lib/scoring.ts → scoreLead().breakdown), not from new prose;
 *   - the call script comes from the existing GET /api/outreach?id= draft
 *     (src/lib/outreach.ts) — display/copy only, nothing is sent;
 *   - logging a call POSTs the existing POST /api/leads/contact?id= with
 *     channel "Phone call", and the response classification goes through the
 *     existing PATCH /api/leads?id= (whose cadence reconciliation is the same
 *     engine). This page writes NO business logic of its own: dates, counts,
 *     status and the next follow-up are all decided server-side.
 *
 * Nothing here sends, texts or emails anything. The human dials and taps.
 */

/**
 * The "Logged — next follow-up …" confirmation is kept here as well as in React
 * state: a successful log re-runs the loader, and if that remounts this
 * component a state-only banner would vanish before anyone saw it.
 */
let pendingLogMessage: string | null = null;

/** The call-sheet lead fields plus the website the scorer reads. */
interface CallRow extends CallLead {
  website: string | null;
}

interface CallSheet {
  today: string;
  rows: CallRow[];
  /** Leads whose last contact was today — the honest "calls logged today". */
  loggedToday: number;
  /** Stored next_follow_up_date on/before today and the cadence still says due. */
  dueToday: number;
  /** Never contacted: no touch count, no last-contact date. */
  untouched: number;
}

/** Sign-on gate (server-side) — identical to /leads and /dashboard. */
const checkSignOn = createServerFn({ method: "GET" }).handler(async () => {
  const { getRequest } = await import("@tanstack/react-start/server");
  return { signedIn: isAuthenticatedRequest(getRequest()) };
});

async function requireSignOn(next?: string): Promise<void> {
  const { signedIn } = await checkSignOn();
  if (!signedIn)
    throw redirect({
      to: "/login",
      search: next ? { next } : {},
    });
}

/**
 * The sheet's data. Read-only: listLeads() + the shared cadence rule for the
 * header counts. Nothing is written here.
 */
const getCallSheet = createServerFn({ method: "GET" }).handler(
  async (): Promise<CallSheet> => {
    const { getRequest } = await import("@tanstack/react-start/server");
    if (!isAuthenticatedRequest(getRequest())) throw redirect({ to: "/login" });
    const today = todayOnly();
    const leads = listLeads();
    const rows: CallRow[] = leads.map((l) => ({
      id: l.id,
      company_name: l.company_name,
      city: l.city,
      phone: l.phone,
      email: l.email,
      website: l.website,
      contact_name: l.contact_name,
      contact_role: l.contact_role,
      lead_type: l.lead_type,
      lead_status: l.lead_status,
      lead_score: l.lead_score,
      score_tier: l.score_tier,
      response_classification: l.response_classification,
      follow_up_count: l.follow_up_count,
      first_contact_date: l.first_contact_date,
      last_contact_date: l.last_contact_date,
      next_follow_up_date: l.next_follow_up_date,
    }));

    const loggedToday = rows.filter((r) => r.last_contact_date === today).length;
    // Same definition the dashboard's due queue uses: a real stored date, on or
    // before today, and the cadence engine has not stopped it.
    const dueToday = rows.filter(
      (r) =>
        r.next_follow_up_date !== null &&
        r.next_follow_up_date <= today &&
        cadenceStopReason(r) === null,
    ).length;
    const untouched = rows.filter(
      (r) => (r.follow_up_count ?? 0) === 0 && r.last_contact_date === null,
    ).length;

    return { today, rows, loggedToday, dueToday, untouched };
  },
);

export const Route = createFileRoute("/calls")({
  head: () => ({ meta: [{ title: "Today's call sheet — Trust Care Agency" }] }),
  beforeLoad: async ({ location }) => {
    await requireSignOn(location.href);
  },
  loader: () => getCallSheet(),
  component: CallsPage,
});

/* -------------------------------------------------------------------------- */
/*  Small, honest display helpers                                             */
/* -------------------------------------------------------------------------- */

/** Trimmed email, or "" when the lead has none on file (phone is the way in). */
function leadEmail(lead: { email: string | null }): string {
  return (lead.email ?? "").trim();
}

function leadPhone(lead: { phone: string | null }): string {
  return (lead.phone ?? "").trim();
}

/** `tel:` target — digits and a leading + only, so phones dial cleanly. */
function telHref(phone: string): string {
  const plus = phone.trim().startsWith("+") ? "+" : "";
  return `tel:${plus}${phone.replace(/[^\d]/g, "")}`;
}

const REASON_LABEL: Record<keyof ScoreBreakdown, string> = {
  typeDemand: "facility type demand",
  reachability: "reachability",
  contact: "contact depth",
  engagement: "engagement",
  momentum: "touches logged",
};

/** Tie order: the reason a facility buyer matters most wins a tie. */
const REASON_ORDER: Array<keyof ScoreBreakdown> = [
  "typeDemand",
  "contact",
  "reachability",
  "engagement",
  "momentum",
];

/**
 * "Why this one" — the single strongest component of the EXISTING score
 * breakdown (src/lib/scoring.ts). No new prose, no invented rationale: the
 * number shown is literally the points that component contributed.
 */
function strongestReason(lead: CallRow): { label: string; points: number } {
  const { breakdown } = scoreLead({
    lead_type: lead.lead_type,
    lead_status: lead.lead_status,
    contact_name: lead.contact_name,
    contact_role: lead.contact_role,
    email: lead.email,
    phone: lead.phone,
    website: lead.website,
    follow_up_count: lead.follow_up_count,
  });
  let best = REASON_ORDER[0];
  for (const key of REASON_ORDER) {
    if (breakdown[key] > breakdown[best]) best = key;
  }
  return { label: REASON_LABEL[best], points: breakdown[best] };
}

function tierBadge(tier: string | null) {
  const t = (tier ?? "").toUpperCase();
  const cls =
    t === "HOT"
      ? "bg-red-100 text-red-700"
      : t === "WARM"
        ? "bg-amber-100 text-amber-800"
        : "bg-sky-100 text-sky-700";
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>
      {t || "—"}
    </span>
  );
}

/** The five ways a call ends (the existing RESPONSE_CLASSIFICATIONS set). */
const RESPONSE_BUTTONS: Array<{ value: string; className: string }> = [
  {
    value: "Interested",
    className: "bg-emerald-700 text-white hover:bg-emerald-800 active:bg-emerald-900",
  },
  {
    value: "Needs Staffing",
    className: "bg-amber-500 text-gray-900 hover:bg-amber-600 active:bg-amber-700",
  },
  {
    value: "No Response",
    className: "bg-gray-600 text-white hover:bg-gray-700 active:bg-gray-800",
  },
  {
    value: "Not Interested",
    className:
      "border border-amber-300 bg-[#EFF3F8] text-amber-900 hover:bg-amber-50",
  },
  {
    value: "Do Not Contact",
    className:
      "border border-red-300 bg-[#EFF3F8] text-red-700 hover:bg-red-50",
  },
];

const STAT_CHIPS: Array<{ key: "loggedToday" | "dueToday" | "untouched"; label: string }> = [
  { key: "loggedToday", label: "Calls logged today" },
  { key: "dueToday", label: "Due today" },
  { key: "untouched", label: "Untouched" },
];

function CallsPage() {
  const data = Route.useLoaderData();
  const router = useRouter();

  /**
   * Email dimension: "phone" (the default — for those leads the phone is the
   * ONLY way in), "email", or null for both. Named-contact is an independent
   * toggle that composes with either.
   */
  const [emailFilter, setEmailFilter] = useState<"phone" | "email" | null>(
    "phone",
  );
  const [namedOnly, setNamedOnly] = useState(false);
  const [page, setPage] = useState(0);

  const [openScriptId, setOpenScriptId] = useState<number | null>(null);
  const [drafts, setDrafts] = useState<Record<number, OutreachDrafts>>({});
  const [scriptError, setScriptError] = useState<Record<number, string>>({});
  const [loadingScriptId, setLoadingScriptId] = useState<number | null>(null);

  const [notes, setNotes] = useState<Record<number, string>>({});
  const [savingId, setSavingId] = useState<number | null>(null);
  const [flash, setFlash] = useState<string | null>(() => pendingLogMessage);
  const [error, setError] = useState<string | null>(null);

  /** Auto-hide the confirmation, including one restored after a remount. */
  useEffect(() => {
    if (flash === null) return;
    pendingLogMessage = null;
    const timer = window.setTimeout(() => setFlash(null), 8000);
    return () => window.clearTimeout(timer);
  }, [flash]);

  /**
   * The whole view, computed by src/lib/callsheet.ts from stored leads only:
   * terminal leads dropped by the shared cadence rule, leads already called
   * today dropped, due/overdue first then score descending, 12 per batch.
   * Counts recompute from real data, so the header is never optimistic.
   */
  const sheet = useMemo(
    () =>
      selectCalls(data.rows, {
        today: data.today,
        emailFilter,
        namedOnly,
        page,
        now: dateOnlyToDate(data.today),
      }),
    [data.rows, data.today, emailFilter, namedOnly, page],
  );
  const { counts, batch, ordered, pageCount, page: currentPage } = sheet;

  function chooseEmailFilter(next: "phone" | "email") {
    setEmailFilter((v) => (v === next ? null : next));
    setPage(0);
  }

  async function toggleScript(id: number) {
    if (openScriptId === id) {
      setOpenScriptId(null);
      return;
    }
    setOpenScriptId(id);
    if (drafts[id]) return;
    setLoadingScriptId(id);
    setScriptError((e) => ({ ...e, [id]: "" }));
    try {
      // The existing endpoint — the same drafts /leads shows. Nothing sends it.
      const res = await fetch(`/api/outreach?id=${id}`);
      if (!res.ok) throw new Error("Could not load the call script");
      const body = (await res.json()) as { drafts: OutreachDrafts };
      setDrafts((d) => ({ ...d, [id]: body.drafts }));
    } catch (err) {
      setScriptError((e) => ({
        ...e,
        [id]: err instanceof Error ? err.message : "Could not load the call script",
      }));
    } finally {
      setLoadingScriptId(null);
    }
  }

  /**
   * ONE tap = one logged call.
   *   1. POST /api/leads/contact?id= { channel: "Phone call", note }
   *      → last_contact_date = today, follow_up_count +1, next date from the
   *        Day 0/3/7/14 cadence, status Contacted, dated note appended.
   *   2. PATCH /api/leads?id= { response_classification }
   *      → the existing endpoint reconciles the next date through the same
   *        engine (terminal responses stop the cadence and clear the date).
   * Both are existing endpoints; this page duplicates none of that logic.
   */
  async function logCall(lead: CallRow, response: string) {
    setSavingId(lead.id);
    setError(null);
    const note = (notes[lead.id] ?? "").trim();
    try {
      const res = await fetch(`/api/leads/contact?id=${lead.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: "Phone call", note }),
      });
      const body = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!res.ok) throw new Error(body?.error ?? "Could not log the call");

      const patch = await fetch(`/api/leads?id=${lead.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response_classification: response }),
      });
      // PATCH /api/leads answers { lead: {...} } — read the follow-up date off
      // the record, not the envelope. Reading it at the top level always came
      // back undefined, so the confirmation told the caller "no follow-up
      // scheduled" on every non-terminal call even though the cadence had just
      // set one (verified against the store: No Response → next = today + 3).
      const patched = (await patch.json().catch(() => null)) as {
        error?: string;
        lead?: { next_follow_up_date?: string | null };
      } | null;
      if (!patch.ok)
        throw new Error(
          patched?.error ??
            "The call was logged, but the response could not be saved — open /leads to set it.",
        );

      await router.invalidate(); // re-run the loader → counters from real data
      setNotes((prev) => {
        const next = { ...prev };
        delete next[lead.id];
        return next;
      });
      if (openScriptId === lead.id) setOpenScriptId(null);

      const name = lead.company_name ?? `Lead #${String(lead.id)}`;
      const nextDate = patched?.lead?.next_follow_up_date ?? null;
      const tail =
        nextDate !== null
          ? `next follow-up ${nextDate}`
          : response === "Not Interested" || response === "Do Not Contact"
            ? `cadence stopped — ${response}`
            : "no follow-up scheduled";
      // Set module scope first, then state: whichever instance survives the
      // loader re-run shows the confirmation.
      pendingLogMessage = `Logged — ${name}: ${response}, ${tail}`;
      setFlash(pendingLogMessage);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not log the call");
    } finally {
      setSavingId(null);
    }
  }

  const { rangeStart, rangeEnd } = sheet;

  return (
    <main className="call-sheet min-h-dvh bg-emerald-50 px-4 py-6 sm:px-6 sm:py-10">
      <div className="mx-auto max-w-3xl">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-emerald-700">
              Trust Care Agency
            </p>
            <h1 className="mt-1 text-3xl font-bold tracking-tight text-emerald-950">
              Today&apos;s call sheet
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-gray-600">
              Work down the list, one call at a time. The number is tappable,
              the call script copies in one tap, and logging the call sets the
              next follow-up for you.
            </p>
          </div>
          <div className="no-print flex flex-col items-stretch gap-3 sm:items-end">
            <Link
              to="/dashboard"
              className="min-h-[44px] rounded-lg border border-emerald-200 bg-[#EFF3F8] px-4 py-2 text-center text-sm font-medium text-emerald-800 shadow-sm hover:bg-emerald-50"
            >
              ← Sales dashboard
            </Link>
            <Link
              to="/leads"
              className="min-h-[44px] rounded-lg border border-emerald-200 bg-[#EFF3F8] px-4 py-2 text-center text-sm font-medium text-emerald-800 shadow-sm hover:bg-emerald-50"
            >
              All leads →
            </Link>
            <TeamAccount />
          </div>
        </div>

        {/* Header strip — every number computed from the stored leads. */}
        <div className="mt-5 grid grid-cols-3 gap-2 sm:gap-3">
          {STAT_CHIPS.map((c) => (
            <div
              key={c.key}
              className="rounded-xl border border-emerald-100 bg-[#EFF3F8] p-3 shadow-sm"
            >
              <p className="text-[11px] font-medium uppercase leading-tight tracking-wide text-gray-500">
                {c.label}
              </p>
              <p className="mt-0.5 text-2xl font-bold text-emerald-950">
                {data[c.key]}
              </p>
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-gray-600">
          {data.loggedToday} call{data.loggedToday === 1 ? "" : "s"} logged today
          are off this sheet · {data.dueToday} follow-up
          {data.dueToday === 1 ? "" : "s"} due · {data.untouched} of{" "}
          {data.rows.length} leads never contacted.
        </p>

        {flash ? (
          <p className="mt-4 rounded-lg border border-emerald-300 bg-emerald-100 px-4 py-3 text-sm font-medium text-emerald-900">
            ✓ {flash}
          </p>
        ) : null}
        {error ? (
          <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-medium text-red-700">
            {error}
          </p>
        ) : null}

        {/* Filters — chips that compose with the batch paging. */}
        <div className="no-print mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => chooseEmailFilter("phone")}
            aria-pressed={emailFilter === "phone"}
            className={`min-h-[44px] rounded-lg border px-3 py-2 text-sm font-semibold shadow-sm ${
              emailFilter === "phone"
                ? "border-emerald-400 bg-emerald-800 text-white"
                : "border-emerald-200 bg-[#EFF3F8] text-emerald-800 hover:bg-emerald-50"
            }`}
          >
            {emailFilter === "phone" ? "✓ " : ""}Phone-only (no email) (
            {counts.phoneOnly})
          </button>
          <button
            type="button"
            onClick={() => chooseEmailFilter("email")}
            aria-pressed={emailFilter === "email"}
            className={`min-h-[44px] rounded-lg border px-3 py-2 text-sm font-semibold shadow-sm ${
              emailFilter === "email"
                ? "border-emerald-400 bg-emerald-800 text-white"
                : "border-emerald-200 bg-[#EFF3F8] text-emerald-800 hover:bg-emerald-50"
            }`}
          >
            {emailFilter === "email" ? "✓ " : ""}Has email ({counts.email})
          </button>
          <button
            type="button"
            onClick={() => {
              setNamedOnly((v) => !v);
              setPage(0);
            }}
            aria-pressed={namedOnly}
            className={`min-h-[44px] rounded-lg border px-3 py-2 text-sm font-semibold shadow-sm ${
              namedOnly
                ? "border-emerald-400 bg-emerald-800 text-white"
                : "border-emerald-200 bg-[#EFF3F8] text-emerald-800 hover:bg-emerald-50"
            }`}
          >
            {namedOnly ? "✓ " : ""}Named contact ({counts.named})
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            className="min-h-[44px] rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900 shadow-sm hover:bg-amber-100"
          >
            🖨 Print this batch
          </button>
        </div>

        {/* Batch paging — 12 calls a person can actually finish. */}
        <div className="no-print mt-4 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-gray-700">
            {batch.length === 0 ? (
              <>No calls match this view</>
            ) : (
              <>
                <span className="font-semibold text-emerald-950">
                  {rangeEnd} of {ordered.length} calls
                </span>
                <span className="text-gray-500">
                  {" "}
                  ({rangeStart}–{rangeEnd})
                </span>
              </>
            )}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={currentPage === 0}
              onClick={() => setPage(Math.max(0, currentPage - 1))}
              className="min-h-[44px] rounded-lg border border-emerald-200 bg-[#EFF3F8] px-4 py-2 text-sm font-semibold text-emerald-800 shadow-sm hover:bg-emerald-50 disabled:opacity-40"
            >
              ← Back
            </button>
            <button
              type="button"
              disabled={currentPage >= pageCount - 1}
              onClick={() => setPage(Math.min(pageCount - 1, currentPage + 1))}
              className="min-h-[44px] rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-800 disabled:opacity-40"
            >
              Next {CALL_BATCH_SIZE} →
            </button>
          </div>
        </div>

        {ordered.length === 0 ? (
          <div className="mt-6 rounded-xl border border-emerald-100 bg-[#EFF3F8] p-6 text-center shadow-sm">
            <p className="font-semibold text-emerald-950">
              Nothing left to call in this view.
            </p>
            <p className="mt-1 text-sm text-gray-600">
              Every lead here has been called today, is closed (Not Interested /
              Do Not Contact), or this filter has nothing left. Try another
              filter above.
            </p>
          </div>
        ) : null}

        <ul className="mt-5 space-y-3">
          {batch.map(({ lead, state }) => {
            const phone = leadPhone(lead);
            const email = leadEmail(lead);
            const contactName = (lead.contact_name ?? "").trim();
            const role = (lead.contact_role ?? "").trim();
            const roleSaysUnverified = /unverif|not verified/i.test(role);
            const reason = strongestReason(lead);
            const scriptOpen = openScriptId === lead.id;
            const draftsForLead = drafts[lead.id];
            const busy = savingId === lead.id;

            return (
              <li
                key={lead.id}
                className="call-card rounded-xl border border-emerald-100 bg-[#EFF3F8] p-4 shadow-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-emerald-950">
                      {lead.company_name ?? "—"}
                    </p>
                    <p className="text-xs text-gray-600">
                      {[lead.city, lead.lead_type].filter(Boolean).join(" · ") ||
                        "—"}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {tierBadge(lead.score_tier)}
                    <span className="text-lg font-bold text-emerald-950">
                      {lead.lead_score ?? "—"}
                    </span>
                  </div>
                </div>

                {/* Who to ask for. A role with no name keeps its own caveat —
                    we never imply we know a person we don't. */}
                <p className="mt-2 text-sm text-gray-700 call-contact">
                  {contactName !== "" ? (
                    <>
                      <span className="font-medium text-emerald-950">
                        {contactName}
                      </span>
                      {role !== "" ? (
                        <span className="text-gray-600"> · {role}</span>
                      ) : null}
                    </>
                  ) : role !== "" ? (
                    <>
                      <span className="text-gray-600">{role}</span>
                      {roleSaysUnverified ? (
                        <span className="ml-1 font-medium text-amber-800">
                          (unverified — confirm who answers)
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-gray-500">
                      No named contact — ask for the Director of Nursing or HR
                    </span>
                  )}
                </p>

                {/* The number: big, tappable, copyable. */}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {phone !== "" ? (
                    <a
                      href={telHref(phone)}
                      className="call-number min-h-[52px] flex-1 whitespace-nowrap rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xl font-bold tracking-tight text-emerald-900 underline decoration-emerald-300 underline-offset-4"
                    >
                      📞 {phone}
                    </a>
                  ) : (
                    <span className="min-h-[44px] flex-1 py-2 text-sm text-gray-500">
                      No phone on file
                      {email !== "" ? ` — email ${email}` : ""}
                    </span>
                  )}
                  {phone !== "" ? (
                    <span className="no-print">
                      <CopyButton text={phone} label="Copy number" />
                    </span>
                  ) : null}
                </div>
                {email !== "" ? (
                  <p className="mt-1 break-all text-xs text-gray-500">
                    Also has email: {email}
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-gray-500">
                    No email on file — the phone is the only way in
                  </p>
                )}

                <p className="mt-2 text-sm text-gray-700">
                  <span className="font-medium text-gray-500">
                    Why this one:{" "}
                  </span>
                  {reason.label} <span className="text-gray-500">+{reason.points}</span>
                </p>
                <p className="mt-1 text-sm font-medium text-emerald-900 call-status">
                  {callStatusLine(lead, state)}
                </p>

                {/* The call script — existing draft, copy only. */}
                <div className="no-print mt-3">
                  <button
                    type="button"
                    onClick={() => void toggleScript(lead.id)}
                    aria-expanded={scriptOpen}
                    className="min-h-[44px] w-full rounded-lg border border-emerald-200 bg-[#EFF3F8] px-3 py-2 text-sm font-semibold text-emerald-800 shadow-sm hover:bg-emerald-50"
                  >
                    {scriptOpen ? "Hide call script" : "☎ Call script"}
                  </button>
                  {scriptOpen ? (
                    <div className="mt-2 rounded-lg border border-emerald-100 bg-emerald-50/60 p-3">
                      {loadingScriptId === lead.id ? (
                        <p className="text-sm text-gray-600">
                          Loading call script…
                        </p>
                      ) : draftsForLead ? (
                        <>
                          <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-[#EFF3F8] p-3 font-sans text-sm leading-relaxed text-gray-700">
                            {draftsForLead.callScript}
                          </pre>
                          <div className="mt-2">
                            <CopyButton
                              text={draftsForLead.callScript}
                              label="Copy call script"
                            />
                          </div>
                        </>
                      ) : (
                        <p className="text-sm text-red-600">
                          {scriptError[lead.id] ||
                            "Could not load the call script."}
                        </p>
                      )}
                    </div>
                  ) : null}
                </div>

                {/* How the call ended — one tap logs it. */}
                <div className="no-print mt-3 border-t border-emerald-100 pt-3">
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500">
                      Note (optional)
                    </span>
                    <input
                      type="text"
                      value={notes[lead.id] ?? ""}
                      maxLength={200}
                      disabled={busy}
                      onChange={(e) =>
                        setNotes((n) => ({ ...n, [lead.id]: e.target.value }))
                      }
                      placeholder="e.g. asked for CNAs next month"
                      className="w-full rounded-lg border border-emerald-200 bg-emerald-50/40 px-3 py-2 text-sm text-gray-800 placeholder:text-gray-400 focus:border-emerald-400 focus:outline-none"
                    />
                  </label>
                  <p className="mt-2 text-xs text-gray-500">
                    {busy
                      ? "Logging the call…"
                      : "Tap how the call ended — the date, the touch count and the next follow-up are set for you."}
                  </p>
                  <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {RESPONSE_BUTTONS.map((b) => (
                      <button
                        key={b.value}
                        type="button"
                        disabled={busy}
                        onClick={() => void logCall(lead, b.value)}
                        className={`min-h-[48px] rounded-lg px-3 py-2 text-sm font-semibold shadow-sm disabled:opacity-50 ${b.className}`}
                      >
                        {b.value}
                      </button>
                    ))}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>

        <div className="no-print mt-6 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-gray-600">
            Follow-up cadence: Day 0 → Day 3 → Day 7 → Day 14, counted from each
            lead&apos;s first contact. Nothing is sent automatically — you dial
            and log.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={currentPage === 0}
              onClick={() => setPage(Math.max(0, currentPage - 1))}
              className="min-h-[44px] rounded-lg border border-emerald-200 bg-[#EFF3F8] px-4 py-2 text-sm font-semibold text-emerald-800 shadow-sm hover:bg-emerald-50 disabled:opacity-40"
            >
              ← Back
            </button>
            <button
              type="button"
              disabled={currentPage >= pageCount - 1}
              onClick={() => setPage(Math.min(pageCount - 1, currentPage + 1))}
              className="min-h-[44px] rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-800 disabled:opacity-40"
            >
              Next {CALL_BATCH_SIZE} →
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
