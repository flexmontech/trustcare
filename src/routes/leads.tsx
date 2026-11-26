import {
  Link,
  createFileRoute,
  redirect,
  useRouter,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Fragment, useMemo, useState } from "react";
import { AddProspectPanel } from "~/components/add-prospect";
import type { CreatedLeadSummary } from "~/components/add-prospect";
import { CopyButton } from "~/components/copy-button";
import { CsvImportPanel } from "~/components/csv-import";
import { TeamAccount } from "~/components/team-account";
import { isAuthenticatedRequest } from "~/lib/auth";
import { leadKey } from "~/lib/csv-import";
import { RESPONSE_CLASSIFICATIONS, getFollowUpState } from "~/lib/followup";
import type { OutreachDrafts } from "~/lib/outreach";
import { listLeads } from "~/lib/store";

/**
 * All-leads list + search (server-backed by the $0 file-based JSON store,
 * src/lib/store.ts — no database, no DATABASE_URL, no Neon).
 *
 * The full 40-lead seed list is fetched once server-side (createServerFn →
 * listLeads()); search + status filtering happen client-side so typing is
 * instant. Per-lead outreach drafts come from the existing GET /api/outreach
 * endpoint, and status/response updates persist via PATCH /api/leads?id= —
 * both reuse the already-built API, nothing new to maintain.
 */

interface LeadRow {
  id: number;
  company_name: string | null;
  city: string | null;
  email: string | null;
  phone: string | null;
  contact_name: string | null;
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

/**
 * Sign-on gate (server-side). Without a valid signed session cookie this page
 * redirects to /login, and the lead data server function refuses to return
 * anything either.
 */
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

const getLeads = createServerFn({ method: "GET" }).handler(
  async (): Promise<LeadRow[]> => {
    const { getRequest } = await import("@tanstack/react-start/server");
    if (!isAuthenticatedRequest(getRequest())) throw redirect({ to: "/login" });
    const leads = listLeads().map((l) => ({
      id: l.id,
      company_name: l.company_name,
      city: l.city,
      email: l.email,
      phone: l.phone,
      contact_name: l.contact_name,
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
    // Sales list reads best hottest-first; ties fall back to company name.
    return leads.sort(
      (a, b) =>
        (b.lead_score ?? 0) - (a.lead_score ?? 0) ||
        (a.company_name ?? "").localeCompare(b.company_name ?? ""),
    );
  },
);

export const Route = createFileRoute("/leads")({
  head: () => ({ meta: [{ title: "Leads — Trust Care Agency" }] }),
  beforeLoad: async ({ location }) => {
    await requireSignOn(location.href);
  },
  loader: () => getLeads(),
  component: LeadsPage,
});

const STATUS_OPTIONS = [
  "New",
  "Contacted",
  "Interested",
  "Appointment",
  "Converted",
  "Do Not Contact",
];

const RESPONSE_OPTIONS = [...RESPONSE_CLASSIFICATIONS];

/** A lead's email as a trimmed string, or "" when there is none on file. */
function leadEmail(lead: { email: string | null }): string {
  return (lead.email ?? "").trim();
}

/** A lead's phone as a trimmed string, or "" when there is none on file. */
function leadPhone(lead: { phone: string | null }): string {
  return (lead.phone ?? "").trim();
}

/** `tel:` target — digits and a leading + only, so iOS/Android dial cleanly. */
function telHref(phone: string): string {
  const plus = phone.trim().startsWith("+") ? "+" : "";
  return `tel:${plus}${phone.replace(/[^\d]/g, "")}`;
}

/**
 * A pre-filled `mailto:` for ONE lead and ONE recipient — never more.
 * Line breaks are encoded as %0D%0A so the paragraphs survive the trip into
 * Gmail/Outlook. Nothing is sent by this; the human still presses Send.
 */
function mailtoHref(to: string, subject: string, body: string): string {
  const recipient = encodeURIComponent(to).replace(/%40/g, "@");
  const bodyEncoded = encodeURIComponent(body).replace(/%0A/g, "%0D%0A");
  return `mailto:${recipient}?subject=${encodeURIComponent(subject)}&body=${bodyEncoded}`;
}

/**
 * Who to contact, at a glance — used in the desktop table's Contact column.
 * An empty email is stated plainly ("— no email"), because "this lead can only
 * be phoned" is useful information, not a blank to puzzle over.
 */
function ContactCell({ lead }: { lead: LeadRow }) {
  const email = leadEmail(lead);
  const phone = leadPhone(lead);
  return (
    <div className="max-w-[15rem] text-sm">
      {email !== "" ? (
        <a
          href={`mailto:${email}`}
          className="block break-all font-medium text-emerald-800 underline decoration-emerald-300 underline-offset-2 hover:text-emerald-900"
        >
          {email}
        </a>
      ) : (
        <span className="block text-gray-400">— no email</span>
      )}
      {phone !== "" ? (
        <a
          href={telHref(phone)}
          className="block whitespace-nowrap text-xs text-gray-600 hover:text-emerald-800 hover:underline"
        >
          {phone}
        </a>
      ) : (
        <span className="block text-xs text-gray-400">— no phone</span>
      )}
    </div>
  );
}

/**
 * The phone-card version of the contact block: the email (or an honest
 * "phone only"), the phone, and a 44px Copy button on each — under the company
 * name, so staff can work straight down the list without opening anything.
 */
function ContactBlock({ lead }: { lead: LeadRow }) {
  const email = leadEmail(lead);
  const phone = leadPhone(lead);
  return (
    <div className="mt-2 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {email !== "" ? (
          <>
            <a
              href={`mailto:${email}`}
              className="min-h-[44px] min-w-0 flex-1 break-all rounded-lg py-2 text-sm font-medium text-emerald-800 underline decoration-emerald-300 underline-offset-2"
            >
              {email}
            </a>
            <CopyButton text={email} label="Copy email" />
          </>
        ) : (
          <span className="min-h-[44px] flex-1 py-2 text-sm text-gray-500">
            No email on file — phone only
          </span>
        )}
      </div>
      {phone !== "" ? (
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={telHref(phone)}
            className="min-h-[44px] flex-1 whitespace-nowrap rounded-lg py-2 text-sm font-medium text-gray-700 underline decoration-gray-300 underline-offset-2"
          >
            {phone}
          </a>
          <CopyButton text={phone} label="Copy phone" />
        </div>
      ) : (
        <p className="text-sm text-gray-500">No phone on file</p>
      )}
    </div>
  );
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

/** Follow-up cadence cell: "Second follow-up (Day 7) · due 2026-09-13", "Due now", or complete. */
function FollowUpCell({ lead }: { lead: LeadRow }) {
  const state = getFollowUpState({
    follow_up_count: lead.follow_up_count ?? 0,
    first_contact_date: lead.first_contact_date,
    last_contact_date: lead.last_contact_date,
    next_follow_up_date: lead.next_follow_up_date,
    lead_status: lead.lead_status,
    response_classification: lead.response_classification,
  });
  if (state.isComplete) {
    return (
      <span title={state.nextAction} className="cursor-help text-gray-500">
        Complete
      </span>
    );
  }
  const label = `${state.stepLabel} (Day ${state.stepDay})`;
  if (state.isDue && lead.next_follow_up_date !== null) {
    return (
      <span>
        <span className="text-gray-700">{label}</span>{" "}
        <span className="whitespace-nowrap font-semibold text-red-600">
          · Due now
        </span>
      </span>
    );
  }
  if (lead.first_contact_date === null && lead.last_contact_date === null) {
    return <span className="text-gray-500">Not contacted yet</span>;
  }
  return (
    <span className="text-gray-700">
      {label}
      {state.nextDueDate ? ` · due ${state.nextDueDate}` : ""}
    </span>
  );
}

/** Last contact / next follow-up dates, at a glance. */
function ContactDates({ lead }: { lead: LeadRow }) {
  return (
    <span className="whitespace-nowrap text-sm text-gray-700">
      <span className="block">{lead.last_contact_date ?? "—"}</span>
      <span className="block text-xs text-gray-500">
        {lead.follow_up_count ?? 0}{" "}
        {(lead.follow_up_count ?? 0) === 1 ? "touch" : "touches"}
      </span>
    </span>
  );
}

/** Expandable per-row status/response editor, saved via PATCH /api/leads?id= */
function StatusForm({
  lead,
  saving,
  onSave,
  onCancel,
}: {
  lead: LeadRow;
  saving: boolean;
  onSave: (patch: {
    lead_status: string;
    response_classification: string | null;
  }) => void;
  onCancel: () => void;
}) {
  const [status, setStatus] = useState(lead.lead_status ?? "New");
  const [response, setResponse] = useState(
    lead.response_classification ?? "",
  );
  return (
    <div className="flex flex-wrap items-end gap-4">
      <label className="block">
        <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500">
          Lead status
        </span>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="rounded-lg border border-emerald-200 bg-[#EFF3F8] px-2 py-1.5 text-sm text-gray-800"
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500">
          Response classification
        </span>
        <select
          value={response}
          onChange={(e) => setResponse(e.target.value)}
          className="rounded-lg border border-emerald-200 bg-[#EFF3F8] px-2 py-1.5 text-sm text-gray-800"
        >
          <option value="">— none —</option>
          {RESPONSE_OPTIONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={saving}
          onClick={() =>
            onSave({ lead_status: status, response_classification: response || null })
          }
          className="min-h-[44px] rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={onCancel}
          className="min-h-[44px] rounded-lg border border-emerald-200 bg-[#EFF3F8] px-3 py-2 text-sm font-medium text-emerald-800 hover:bg-emerald-50"
        >
          Cancel
        </button>
      </div>
      <p className="w-full text-xs text-gray-500">
        Saving recomputes the next follow-up date from the cadence. "Not
        Interested" or "Do Not Contact" stops follow-ups and clears the date;
        "Interested", "Needs Staffing" and "No Response" keep them coming. Use{" "}
        <span className="font-medium">Log contact</span> to record an actual
        call, email or visit.
      </p>
    </div>
  );
}

/** The three ways staff reach a lead — big, plain-word tap targets. */
const LOG_CHANNELS: Array<{ value: string; label: string; sub: string }> = [
  { value: "Phone call", label: "📞 I called", sub: "Phone call" },
  { value: "Email", label: "✉️ I emailed", sub: "Email" },
  { value: "In person / other", label: "🤝 In person / other", sub: "Visit or other" },
];

/**
 * THE main action: log a contact in one tap.
 *
 * Tapping a channel POSTs to /api/leads/contact?id=, which sets
 * last_contact_date, bumps follow_up_count, schedules the next date from the
 * Day 0/3/7/14 cadence and marks the lead Contacted — all at once. The note is
 * optional (type it first if there's anything worth remembering); nothing here
 * is a multi-step wizard.
 */
function LogContactForm({
  lead,
  saving,
  onLog,
  onCancel,
}: {
  lead: LeadRow;
  saving: boolean;
  onLog: (channel: string, note: string) => void;
  onCancel: () => void;
}) {
  const [note, setNote] = useState("");
  const state = getFollowUpState({
    follow_up_count: lead.follow_up_count ?? 0,
    first_contact_date: lead.first_contact_date,
    last_contact_date: lead.last_contact_date,
    next_follow_up_date: lead.next_follow_up_date,
    lead_status: lead.lead_status,
    response_classification: lead.response_classification,
  });
  return (
    <div>
      <p className="text-base font-semibold text-emerald-950">
        Log a contact{lead.company_name ? ` — ${lead.company_name}` : ""}
      </p>
      <p className="mt-1 text-sm text-gray-600">
        Tap what you did. The date is set to today, the touch is counted, and the
        next follow-up is scheduled for you.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        {LOG_CHANNELS.map((c) => (
          <button
            key={c.value}
            type="button"
            disabled={saving}
            onClick={() => onLog(c.value, note)}
            className="flex min-h-[56px] flex-col items-center justify-center rounded-xl bg-emerald-700 px-4 py-3 text-base font-semibold text-white shadow-sm transition hover:bg-emerald-800 active:bg-emerald-900 disabled:opacity-50"
          >
            <span>{c.label}</span>
            <span className="text-xs font-normal text-emerald-100">{c.sub}</span>
          </button>
        ))}
      </div>
      <label className="mt-4 block">
        <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500">
          Note (optional)
        </span>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          maxLength={500}
          placeholder="e.g. Spoke with the director of nursing — short on CNAs next month"
          className="w-full rounded-lg border border-emerald-200 bg-emerald-50/40 px-3 py-2 text-sm text-gray-800 placeholder:text-gray-400 focus:border-emerald-400 focus:outline-none"
        />
      </label>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={saving}
          onClick={onCancel}
          className="min-h-[44px] rounded-lg border border-emerald-200 bg-emerald-50/40 px-4 py-2 text-sm font-medium text-emerald-800 hover:bg-emerald-50"
        >
          Cancel
        </button>
        <p className="text-xs text-gray-500">
          {saving ? "Saving…" : state.nextAction}
        </p>
      </div>
    </div>
  );
}

/**
 * Outreach drafts panel — fetched from the existing GET /api/outreach?id=.
 *
 * The panel now answers the question the owner actually has ("who do I send
 * this to?") before showing the copy: the recipient address and phone number
 * sit at the top, each with its own copy button, plus "Open in email app" —
 * a mailto: that opens her mail client pre-filled with the initial email.
 * She still presses Send. One lead, one recipient, nothing automatic.
 *
 * Every draft block (subject, initial body, follow-up body, call script) has
 * its own 44px copy button, because selecting a paragraph by hand on a phone
 * is the step that was blocking her.
 */
function OutreachPanel({
  lead,
  drafts,
}: {
  lead: LeadRow;
  drafts: OutreachDrafts;
}) {
  const email = leadEmail(lead);
  const phone = leadPhone(lead);
  const contact = (lead.contact_name ?? "").trim();
  const initial = drafts.initialEmail;

  const emails: Array<{ title: string; draft: { subject: string; body: string } }> = [
    { title: "Initial email (Day 0)", draft: drafts.initialEmail },
    { title: "Follow-up email (Day 3)", draft: drafts.followUpEmail },
  ];

  return (
    <div className="space-y-4">
      {/* Where it goes — the first thing in the panel, before any text. */}
      <div className="rounded-lg border border-amber-300 bg-amber-50/70 p-3">
        {email !== "" ? (
          <p className="text-sm leading-relaxed text-gray-700">
            <span className="font-semibold text-amber-900">Send to: </span>
            <span className="break-all font-semibold text-emerald-950">
              {email}
            </span>
            <span className="mx-1 text-amber-700">·</span>
            <span className="font-semibold text-amber-900">Call: </span>
            {phone !== "" ? (
              <a
                href={telHref(phone)}
                className="whitespace-nowrap font-semibold text-emerald-800 underline decoration-emerald-300 underline-offset-2"
              >
                {phone}
              </a>
            ) : (
              <span className="text-gray-600">no phone on file</span>
            )}
          </p>
        ) : phone !== "" ? (
          <p className="text-sm leading-relaxed text-gray-700">
            <span className="font-semibold text-amber-900">
              No email on file — call{" "}
            </span>
            <a
              href={telHref(phone)}
              className="whitespace-nowrap font-semibold text-emerald-800 underline decoration-emerald-300 underline-offset-2"
            >
              {phone}
            </a>
          </p>
        ) : (
          <p className="text-sm leading-relaxed text-gray-700">
            <span className="font-semibold text-amber-900">
              No email or phone on file
            </span>{" "}
            — this lead&apos;s website or notes are the only route.
          </p>
        )}
        {contact !== "" ? (
          <p className="mt-1 text-xs text-gray-600">Contact: {contact}</p>
        ) : null}

        <div className="mt-3 flex flex-wrap items-stretch gap-2">
          {email !== "" ? (
            <a
              href={mailtoHref(email, initial.subject, initial.body)}
              className="inline-flex min-h-[48px] items-center justify-center rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-800 active:bg-emerald-900"
            >
              ✉️ Open in email app
            </a>
          ) : null}
          {phone !== "" ? (
            <a
              href={telHref(phone)}
              className="inline-flex min-h-[44px] items-center justify-center rounded-lg border border-emerald-200 bg-[#EFF3F8] px-4 py-2 text-sm font-semibold text-emerald-800 shadow-sm hover:bg-emerald-50"
            >
              📞 Call {phone}
            </a>
          ) : null}
          {email !== "" ? (
            <CopyButton text={email} label="Copy address" />
          ) : null}
          {phone !== "" ? <CopyButton text={phone} label="Copy number" /> : null}
        </div>
        {email !== "" ? (
          <p className="mt-2 text-xs text-gray-600">
            &ldquo;Open in email app&rdquo; fills in the recipient, subject and
            initial email — you still press Send. If your mail app doesn&apos;t
            open, use the copy buttons below.
          </p>
        ) : (
          <p className="mt-2 text-xs text-gray-600">
            No email address is published for this facility — call the number
            above, and use the copy buttons below for the call script.
          </p>
        )}
      </div>

      <p className="text-sm text-gray-600">
        Personalized drafts for staff to review and send manually — nothing is
        sent automatically.
      </p>

      {emails.map(({ title, draft }) => (
        <div key={title} className="rounded-lg border border-emerald-100 bg-emerald-50/50 p-3">
          <p className="text-sm font-semibold text-emerald-950">{title}</p>
          <div className="mt-2 flex flex-wrap items-start justify-between gap-2">
            <p className="min-w-0 flex-1 text-sm">
              <span className="font-medium text-gray-500">Subject: </span>
              <span className="font-medium text-gray-800">{draft.subject}</span>
            </p>
            <CopyButton text={draft.subject} label="Copy subject" />
          </div>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-md bg-[#EFF3F8] p-3 font-sans text-sm leading-relaxed text-gray-700">
            {draft.body}
          </pre>
          <div className="mt-2 flex flex-wrap gap-2">
            <CopyButton
              text={`${draft.subject}\n\n${draft.body}`}
              label="Copy subject + body"
            />
            <CopyButton text={draft.body} label="Copy body" />
          </div>
        </div>
      ))}

      <div className="rounded-lg border border-emerald-100 bg-emerald-50/50 p-3">
        <p className="text-sm font-semibold text-emerald-950">Call script</p>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-md bg-[#EFF3F8] p-3 font-sans text-sm leading-relaxed text-gray-700">
          {drafts.callScript}
        </pre>
        <div className="mt-2 flex flex-wrap gap-2">
          <CopyButton text={drafts.callScript} label="Copy call script" />
        </div>
      </div>
    </div>
  );
}

function LeadsPage() {
  const data = Route.useLoaderData();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  /** "Only leads with an email" — off by default; composes with search + status. */
  const [emailOnly, setEmailOnly] = useState(false);
  const [expanded, setExpanded] = useState<{
    id: number;
    kind: "outreach" | "edit" | "log";
  } | null>(null);
  const [drafts, setDrafts] = useState<Record<number, OutreachDrafts>>({});
  const [draftError, setDraftError] = useState<Record<number, string>>({});
  const [loadingDraftId, setLoadingDraftId] = useState<number | null>(null);
  const [savingId, setSavingId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  // Add-prospect / CSV-import panels — data entry for the team, phone-first.
  const [panel, setPanel] = useState<"add" | "import" | null>(null);

  /** company_name|city keys already stored — the CSV import's duplicate check. */
  const existingKeys = useMemo(
    () => new Set(data.map((l) => leadKey(l.company_name, l.city))),
    [data],
  );
  /** Facility types already in use, offered as suggestions in the add form. */
  const leadTypes = useMemo(
    () =>
      Array.from(
        new Set(data.map((l) => (l.lead_type ?? "").trim()).filter((t) => t !== "")),
      ).sort((a, b) => a.localeCompare(b)),
    [data],
  );

  /** How many leads in the whole list can be reached by email at all. */
  const emailCount = useMemo(
    () => data.filter((l) => leadEmail(l) !== "").length,
    [data],
  );

  const q = query.trim().toLowerCase();
  const filtered = data.filter((l) => {
    if (statusFilter !== "" && (l.lead_status ?? "") !== statusFilter)
      return false;
    if (emailOnly && leadEmail(l) === "") return false;
    if (q === "") return true;
    return (
      (l.company_name ?? "").toLowerCase().includes(q) ||
      (l.city ?? "").toLowerCase().includes(q)
    );
  });

  async function openOutreach(id: number) {
    setExpanded({ id, kind: "outreach" });
    setActionError(null);
    if (drafts[id]) return;
    setLoadingDraftId(id);
    try {
      const res = await fetch(`/api/outreach?id=${id}`);
      if (!res.ok) throw new Error("Could not load outreach drafts");
      const body = (await res.json()) as { drafts: OutreachDrafts };
      setDrafts((d) => ({ ...d, [id]: body.drafts }));
    } catch (err) {
      setDraftError((d) => ({
        ...d,
        [id]: err instanceof Error ? err.message : "Could not load outreach drafts",
      }));
    } finally {
      setLoadingDraftId(null);
    }
  }

  async function saveStatus(
    id: number,
    patch: { lead_status: string; response_classification: string | null },
  ) {
    setSavingId(id);
    setActionError(null);
    try {
      const res = await fetch(`/api/leads?id=${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? "Update failed");
      }
      await router.invalidate(); // re-run loader → fresh scores/tiers/queue
      setExpanded(null);
      const name = data.find((l) => l.id === id)?.company_name ?? `Lead #${id}`;
      setSavedNote(`${name} — status saved`);
      window.setTimeout(() => setSavedNote(null), 4000);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setSavingId(null);
    }
  }

  async function logContact(id: number, channel: string, note: string) {
    setSavingId(id);
    setActionError(null);
    try {
      const res = await fetch(`/api/leads/contact?id=${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, note }),
      });
      const body = (await res.json().catch(() => null)) as {
        error?: string;
        followUp?: {
          next_follow_up_date: string | null;
          stopsCadenceReason: string | null;
          isComplete: boolean;
          nextAction: string;
        };
      } | null;
      if (!res.ok) throw new Error(body?.error ?? "Could not log the contact");
      await router.invalidate(); // re-run loader → fresh dates/queue/score
      setExpanded(null);
      const name = data.find((l) => l.id === id)?.company_name ?? `Lead #${id}`;
      const follow = body?.followUp;
      const detail =
        follow?.next_follow_up_date != null
          ? `next follow-up ${follow.next_follow_up_date}`
          : follow?.stopsCadenceReason
            ? `no follow-up scheduled (${follow.stopsCadenceReason})`
            : follow?.isComplete
              ? "cadence complete — all four touches logged"
              : "no follow-up scheduled";
      setSavedNote(`${name} — contact logged, ${detail}`);
      window.setTimeout(() => setSavedNote(null), 6000);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not log the contact");
    } finally {
      setSavingId(null);
    }
  }

  /** A prospect typed into the Add-prospect form was created via POST /api/leads. */
  async function handleProspectCreated(lead: CreatedLeadSummary) {
    await router.invalidate(); // re-run loader → new lead + score in the list
    setPanel(null);
    setActionError(null);
    setSavedNote(
      `${lead.company_name ?? `Lead #${String(lead.id)}`} added as lead #${String(
        lead.id,
      )} — score ${String(lead.lead_score ?? "—")} ${lead.score_tier ?? ""}`.trim(),
    );
    window.setTimeout(() => setSavedNote(null), 8000);
  }

  /** The CSV import finished: refresh the list so imported leads appear. */
  async function handleImported(summary: {
    added: number;
    skipped: number;
    failed: number;
  }) {
    await router.invalidate();
    setActionError(null);
    if (summary.added > 0) {
      setSavedNote(
        `${String(summary.added)} lead${summary.added === 1 ? "" : "s"} imported into the pipeline`,
      );
      window.setTimeout(() => setSavedNote(null), 8000);
    }
  }

  return (
    <main className="min-h-dvh bg-emerald-50 px-6 py-10">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-emerald-700">
              Trust Care Agency
            </p>
            <h1 className="mt-1 text-3xl font-bold tracking-tight text-emerald-950">
              Leads
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-gray-600">
              Every prospect in the pipeline — each lead&apos;s email and phone
              right on the card, one-tap copy for every draft, and
              &ldquo;Open in email app&rdquo; to pre-fill the message. Log each
              call or email as you go.
            </p>
          </div>
          <div className="flex flex-col items-stretch gap-3 sm:items-end">
            <Link
              to="/dashboard"
              className="rounded-lg border border-emerald-200 bg-[#EFF3F8] px-4 py-2 text-sm font-medium text-emerald-800 shadow-sm hover:bg-emerald-50"
            >
              ← Sales dashboard
            </Link>
            {/* The phone work list — 12 calls at a time, one tap to log. */}
            <Link
              to="/calls"
              className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-800"
            >
              Today&apos;s call sheet
            </Link>
            <TeamAccount />
          </div>
        </div>

        {savedNote ? (
          <p className="mt-4 rounded-lg border border-emerald-200 bg-emerald-100 px-4 py-2 text-sm font-medium text-emerald-900">
            ✓ {savedNote}
          </p>
        ) : null}
        {actionError ? (
          <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-medium text-red-700">
            {actionError}
          </p>
        ) : null}

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by company or city…"
            aria-label="Search leads by company or city"
            className="w-full rounded-lg border border-emerald-200 bg-[#EFF3F8] px-3 py-2 text-sm text-gray-800 shadow-sm placeholder:text-gray-400 focus:border-emerald-400 focus:outline-none sm:w-80"
          />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            aria-label="Filter by lead status"
            className="rounded-lg border border-emerald-200 bg-[#EFF3F8] px-3 py-2 text-sm text-gray-800 shadow-sm focus:border-emerald-400 focus:outline-none"
          >
            <option value="">All statuses</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          {/* Email filter — composes with the search box and the status
              dropdown above. Off by default; the count tells her up front how
              much of the list can be emailed at all. */}
          <button
            type="button"
            onClick={() => setEmailOnly((v) => !v)}
            aria-pressed={emailOnly}
            className={`min-h-[48px] rounded-lg border px-3 py-2 text-sm font-semibold shadow-sm ${
              emailOnly
                ? "border-emerald-400 bg-emerald-800 text-white"
                : "border-emerald-200 bg-[#EFF3F8] text-emerald-800 hover:bg-emerald-50"
            }`}
          >
            {emailOnly ? "✓ " : ""}Only leads with an email ({emailCount})
          </button>
          <p className="text-sm text-gray-600">
            Showing <span className="font-semibold text-emerald-950">{filtered.length}</span>{" "}
            of {data.length} leads
          </p>
          {/* Data entry, phone-first: two 48px-wide buttons on their own row at
              390px (grid-cols-2 so neither label wraps off-screen), inline on
              desktop. The panels they open render BELOW this row, full width —
              never inside the desktop table's horizontal scroller. */}
          <div className="grid w-full grid-cols-2 gap-2 sm:ml-auto sm:flex sm:w-auto sm:items-center">
            <button
              type="button"
              onClick={() => setPanel(panel === "add" ? null : "add")}
              aria-expanded={panel === "add"}
              className={`min-h-[48px] rounded-lg px-4 py-2 text-sm font-semibold shadow-sm ${
                panel === "add"
                  ? "bg-emerald-800 text-white"
                  : "bg-emerald-700 text-white hover:bg-emerald-800 active:bg-emerald-900"
              }`}
            >
              + Add prospect
            </button>
            <button
              type="button"
              onClick={() => setPanel(panel === "import" ? null : "import")}
              aria-expanded={panel === "import"}
              className={`min-h-[48px] rounded-lg border px-4 py-2 text-sm font-semibold shadow-sm ${
                panel === "import"
                  ? "border-emerald-400 bg-emerald-800 text-white"
                  : "border-emerald-200 bg-[#EFF3F8] text-emerald-800 hover:bg-emerald-50"
              }`}
            >
              Import CSV
            </button>
          </div>
        </div>

        {panel === "add" ? (
          <AddProspectPanel
            leadTypes={leadTypes}
            onCreated={(lead) => void handleProspectCreated(lead)}
            onCancel={() => setPanel(null)}
          />
        ) : null}

        {panel === "import" ? (
          <CsvImportPanel
            existingKeys={existingKeys}
            onImported={(summary) => handleImported(summary)}
            onCancel={() => setPanel(null)}
          />
        ) : null}

        {/* Desktop (md and up): the full table, exactly as before. Below md the
            phone cards below take over — a 1120px-wide table inside a ~325px
            window pushes Actions (and the expanded panel's labels) off-screen,
            so a phone user only ever saw blank green bars. */}
        <div className="mt-4 hidden overflow-x-auto rounded-xl border border-emerald-100 bg-[#EFF3F8] shadow-sm md:block">
          <table className="w-full min-w-[1320px] text-left text-sm">
            <thead>
              <tr className="border-b border-emerald-100 text-xs uppercase tracking-wide text-gray-500">
                <th className="px-4 py-2">Company</th>
                <th className="px-4 py-2">Contact</th>
                <th className="px-4 py-2">Type</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Score</th>
                <th className="px-4 py-2">Tier</th>
                <th className="px-4 py-2">Follow-up</th>
                <th className="px-4 py-2">Last contact</th>
                <th className="px-4 py-2">Next follow-up</th>
                <th className="px-4 py-2">Response</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((l) => {
                const isOpen = expanded?.id === l.id;
                const isOutreach = isOpen && expanded.kind === "outreach";
                const isEdit = isOpen && expanded.kind === "edit";
                const isLog = isOpen && expanded.kind === "log";
                return (
                  <Fragment key={l.id}>
                    <tr className="border-b border-emerald-50 align-top last:border-0">
                      <td className="px-4 py-3 font-medium text-emerald-950">
                        {l.company_name ?? "—"}
                        {l.city ? (
                          <span className="ml-1 font-normal text-gray-500">
                            · {l.city}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-3">
                        <ContactCell lead={l} />
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {l.lead_type ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {l.lead_status ?? "—"}
                      </td>
                      <td className="px-4 py-3 font-semibold text-emerald-950">
                        {l.lead_score ?? "—"}
                      </td>
                      <td className="px-4 py-3">{tierBadge(l.score_tier)}</td>
                      <td className="px-4 py-3 text-sm">
                        <FollowUpCell lead={l} />
                      </td>
                      <td className="px-4 py-3">
                        <ContactDates lead={l} />
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-700">
                        {l.next_follow_up_date ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {l.response_classification ?? "—"}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            onClick={() =>
                              isLog
                                ? setExpanded(null)
                                : setExpanded({ id: l.id, kind: "log" })
                            }
                            className="min-h-[44px] whitespace-nowrap rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-800 active:bg-emerald-900"
                          >
                            {isLog ? "Close" : "Log contact"}
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              isOutreach
                                ? setExpanded(null)
                                : openOutreach(l.id)
                            }
                            className="min-h-[44px] rounded-lg border border-emerald-200 bg-[#EFF3F8] px-3 py-2 text-sm font-medium text-emerald-800 hover:bg-emerald-50"
                          >
                            {isOutreach ? "Close" : "Outreach"}
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              isEdit
                                ? setExpanded(null)
                                : setExpanded({ id: l.id, kind: "edit" })
                            }
                            className="min-h-[44px] whitespace-nowrap rounded-lg border border-emerald-200 bg-[#EFF3F8] px-3 py-2 text-sm font-medium text-emerald-800 hover:bg-emerald-50"
                          >
                            {isEdit ? "Close" : "Update status"}
                          </button>
                        </div>
                      </td>
                    </tr>
                    {isLog ? (
                      <tr key={`log-${l.id}`} className="border-b border-emerald-50 bg-emerald-50/40">
                        <td colSpan={11} className="px-4 py-4">
                          <LogContactForm
                            lead={l}
                            saving={savingId === l.id}
                            onCancel={() => setExpanded(null)}
                            onLog={(channel, note) => logContact(l.id, channel, note)}
                          />
                        </td>
                      </tr>
                    ) : null}
                    {isOutreach ? (
                      <tr key={`out-${l.id}`} className="border-b border-emerald-50 bg-emerald-50/40">
                        <td colSpan={11} className="px-4 py-4">
                          {loadingDraftId === l.id ? (
                            <p className="text-sm text-gray-600">
                              Loading outreach drafts…
                            </p>
                          ) : drafts[l.id] ? (
                            <OutreachPanel lead={l} drafts={drafts[l.id]} />
                          ) : (
                            <p className="text-sm text-red-600">
                              {draftError[l.id] ?? "Could not load outreach drafts."}
                            </p>
                          )}
                        </td>
                      </tr>
                    ) : null}
                    {isEdit ? (
                      <tr key={`edit-${l.id}`} className="border-b border-emerald-50 bg-emerald-50/40">
                        <td colSpan={11} className="px-4 py-4">
                          <StatusForm
                            lead={l}
                            saving={savingId === l.id}
                            onCancel={() => setExpanded(null)}
                            onSave={(patch) => saveStatus(l.id, patch)}
                          />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={11} className="px-4 py-8 text-center text-sm text-gray-500">
                    {emailOnly
                      ? "No leads with an email match this search."
                      : "No leads match your search."}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        {/* Phones (below md): one card per lead. Nothing scrolls sideways, so
            "Log contact", last contact and next follow-up are all visible, and
            the expanded panel renders full-width inside the card — not inside
            the horizontal scroller. */}
        <ul className="mt-4 space-y-3 md:hidden">
          {filtered.map((l) => {
            const isOpen = expanded?.id === l.id;
            const isOutreach = isOpen && expanded.kind === "outreach";
            const isEdit = isOpen && expanded.kind === "edit";
            const isLog = isOpen && expanded.kind === "log";
            return (
              <li
                key={l.id}
                className="rounded-xl border border-emerald-100 bg-[#EFF3F8] p-4 shadow-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-emerald-950">
                      {l.company_name ?? "—"}
                    </p>
                    <p className="text-xs text-gray-500">
                      {[l.city, l.lead_type].filter(Boolean).join(" · ") || "—"}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {tierBadge(l.score_tier)}
                    <span className="text-lg font-bold text-emerald-950">
                      {l.lead_score ?? "—"}
                    </span>
                  </div>
                </div>

                {/* Who to contact, right under the name — email (or an honest
                    "phone only") and the number, each with a copy button. */}
                <ContactBlock lead={l} />

                <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 border-t border-emerald-100 pt-3 text-sm">
                  <div>
                    <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">
                      Status
                    </dt>
                    <dd className="text-gray-700">{l.lead_status ?? "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">
                      Last contact
                    </dt>
                    <dd className="whitespace-nowrap text-gray-700">
                      <ContactDates lead={l} />
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">
                      Next follow-up
                    </dt>
                    <dd className="whitespace-nowrap text-gray-700">
                      {l.next_follow_up_date ?? "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">
                      Response
                    </dt>
                    <dd className="text-gray-700">
                      {l.response_classification ?? "—"}
                    </dd>
                  </div>
                  <div className="col-span-2">
                    <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">
                      Follow-up
                    </dt>
                    <dd className="text-sm">
                      <FollowUpCell lead={l} />
                    </dd>
                  </div>
                </dl>

                <div className="mt-3 space-y-2">
                  <button
                    type="button"
                    onClick={() =>
                      isLog
                        ? setExpanded(null)
                        : setExpanded({ id: l.id, kind: "log" })
                    }
                    className="min-h-[48px] w-full rounded-lg bg-emerald-700 px-4 py-3 text-base font-semibold text-white shadow-sm hover:bg-emerald-800 active:bg-emerald-900"
                  >
                    {isLog ? "Close" : "Log contact"}
                  </button>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        isOutreach
                          ? setExpanded(null)
                          : openOutreach(l.id)
                      }
                      className="min-h-[44px] rounded-lg border border-emerald-200 bg-[#EFF3F8] px-3 py-2 text-sm font-medium text-emerald-800 hover:bg-emerald-50"
                    >
                      {isOutreach ? "Close" : "Outreach"}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        isEdit
                          ? setExpanded(null)
                          : setExpanded({ id: l.id, kind: "edit" })
                      }
                      className="min-h-[44px] rounded-lg border border-emerald-200 bg-[#EFF3F8] px-3 py-2 text-sm font-medium text-emerald-800 hover:bg-emerald-50"
                    >
                      {isEdit ? "Close" : "Update status"}
                    </button>
                  </div>
                </div>

                {isOpen ? (
                  <div className="mt-4 border-t border-emerald-100 pt-4">
                    {isLog ? (
                      <LogContactForm
                        lead={l}
                        saving={savingId === l.id}
                        onCancel={() => setExpanded(null)}
                        onLog={(channel, note) => logContact(l.id, channel, note)}
                      />
                    ) : null}
                    {isOutreach ? (
                      loadingDraftId === l.id ? (
                        <p className="text-sm text-gray-600">
                          Loading outreach drafts…
                        </p>
                      ) : drafts[l.id] ? (
                        <OutreachPanel lead={l} drafts={drafts[l.id]} />
                      ) : (
                        <p className="text-sm text-red-600">
                          {draftError[l.id] ??
                            "Could not load outreach drafts."}
                        </p>
                      )
                    ) : null}
                    {isEdit ? (
                      <StatusForm
                        lead={l}
                        saving={savingId === l.id}
                        onCancel={() => setExpanded(null)}
                        onSave={(patch) => saveStatus(l.id, patch)}
                      />
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
          {filtered.length === 0 ? (
            <li className="rounded-xl border border-emerald-100 bg-[#EFF3F8] px-4 py-8 text-center text-sm text-gray-500 shadow-sm">
              {emailOnly
                ? "No leads with an email match this search."
                : "No leads match your search."}
            </li>
          ) : null}
        </ul>

        <p className="mt-4 text-sm text-gray-500">
          Follow-up cadence: Day 0 initial → Day 3 → Day 7 → Day 14 final, counted
          from each lead&apos;s first contact. Logging a contact sets the dates,
          count and status together; scores are recomputed server-side on every
          change.
        </p>
      </div>
    </main>
  );
}