import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { TeamAccount } from "~/components/team-account";
import { isAuthenticatedRequest } from "~/lib/auth";
import { getFollowUpState, todayOnly } from "~/lib/followup";
import { listLeads } from "~/lib/store";

/**
 * Sign-on gate (server-side). The team shares one password; without a valid
 * signed session cookie these pages redirect to /login instead of rendering.
 * The check also runs inside every loader, so the data itself is never
 * returned to a browser that isn't signed in.
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

/**
 * Sales dashboard data (server-only store access; never runs on the client).
 * Reads from the $0 file-based JSON store (src/lib/store.ts), which seeds
 * itself from the 40-row Chicago CSV on first load — always available, no
 * database, no DATABASE_URL.
 */
const getDashboard = createServerFn({ method: "GET" }).handler(async () => {
  const { getRequest } = await import("@tanstack/react-start/server");
  if (!isAuthenticatedRequest(getRequest())) throw redirect({ to: "/login" });
  const leads = listLeads();
  const status = (l: (typeof leads)[number]): string =>
    (l.lead_status ?? "").trim();
  const resp = (l: (typeof leads)[number]): string =>
    (l.response_classification ?? "").trim();
  const tier = (l: (typeof leads)[number]): string =>
    (l.score_tier ?? "").toUpperCase();

  const stats = {
    total: leads.length,
    new_leads: leads.filter((l) => status(l) === "New").length,
    contacted: leads.filter((l) => status(l) === "Contacted").length,
    responses: leads.filter(
      (l) => resp(l) === "Interested" || resp(l) === "Needs Staffing",
    ).length,
    interested: leads.filter((l) => resp(l) === "Interested").length,
    hot: leads.filter((l) => tier(l) === "HOT").length,
    appointments: leads.filter(
      (l) => status(l) === "Appointment" || resp(l) === "Needs Staffing",
    ).length,
    converted: leads.filter((l) => status(l) === "Converted").length,
  };

  const topLeads = [...leads]
    .sort((a, b) => (b.lead_score ?? 0) - (a.lead_score ?? 0) || b.id - a.id)
    .slice(0, 15)
    .map((l) => ({
      id: l.id,
      company_name: l.company_name ?? "",
      city: l.city,
      lead_type: l.lead_type,
      lead_status: l.lead_status,
      lead_score: l.lead_score ?? 0,
      score_tier: l.score_tier,
      response_classification: l.response_classification,
    }));

  // Follow-up queue, driven entirely by real logged activity: a lead is in the
  // queue when its stored next_follow_up_date is on or before today AND the
  // shared cadence engine (src/lib/followup.ts) still says it is due — so
  // terminal leads (Not Interested / Do Not Contact / Converted) and leads whose
  // follow-up is in the future never appear. Most overdue first.
  const today = todayOnly();
  const dueQueue = leads
    .filter(
      (l) => l.next_follow_up_date !== null && l.next_follow_up_date <= today,
    )
    .map((l) => {
      const state = getFollowUpState({
        follow_up_count: l.follow_up_count ?? 0,
        first_contact_date: l.first_contact_date,
        last_contact_date: l.last_contact_date,
        next_follow_up_date: l.next_follow_up_date,
        lead_status: l.lead_status,
        response_classification: l.response_classification,
      });
      return { l, state };
    })
    .filter(({ state }) => state.isDue)
    .sort(
      ({ l: a }, { l: b }) =>
        (a.next_follow_up_date ?? "").localeCompare(b.next_follow_up_date ?? "") ||
        (a.company_name ?? "").localeCompare(b.company_name ?? ""),
    )
    .map(({ l, state }) => ({
      id: l.id,
      company_name: l.company_name ?? "",
      city: l.city,
      lead_type: l.lead_type,
      response_classification: l.response_classification,
      last_contact_date: l.last_contact_date,
      follow_up_count: l.follow_up_count ?? 0,
      stepLabel: state.stepLabel,
      stepDay: state.stepDay,
      nextDueDate: state.nextDueDate,
      nextAction: state.nextAction,
    }));

  return { stats, topLeads, dueQueue, today };
});

export const Route = createFileRoute("/dashboard")({
  head: () => ({ meta: [{ title: "Sales dashboard — Trust Care Agency" }] }),
  beforeLoad: async ({ location }) => {
    await requireSignOn(location.href);
  },
  loader: () => getDashboard(),
  component: Dashboard,
});

const CARDS: Array<{ key: string; label: string }> = [
  { key: "total", label: "Total Leads" },
  { key: "new_leads", label: "New Leads" },
  { key: "contacted", label: "Contacted" },
  { key: "responses", label: "Responses" },
  { key: "interested", label: "Interested" },
  { key: "hot", label: "Hot Leads" },
  { key: "appointments", label: "Appointments" },
  { key: "converted", label: "Converted" },
];

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

function Dashboard() {
  const data = Route.useLoaderData();
  return (
    <main className="min-h-dvh bg-emerald-50 px-6 py-10">
      <div className="mx-auto max-w-5xl">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-emerald-700">
              Trust Care Agency
            </p>
            <h1 className="mt-1 text-3xl font-bold tracking-tight text-emerald-950">
              Sales dashboard
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-gray-600">
              Lead pipeline for Chicago-area caregiver and nursing staffing
              prospects. Outreach drafts are generated per lead for staff to
              review and send — nothing is sent automatically.
            </p>
          </div>
          <div className="flex flex-col items-stretch gap-3 sm:items-end">
            <div className="flex flex-wrap gap-2 sm:justify-end">
              <Link
                to="/leads"
                className="rounded-lg border border-emerald-200 bg-[#EFF3F8] px-4 py-2 text-sm font-medium text-emerald-800 shadow-sm hover:bg-emerald-50"
              >
                All leads →
              </Link>
              {/* The work list: who to phone today, 12 at a time. */}
              <Link
                to="/calls"
                className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-800"
              >
                Today&apos;s call sheet
              </Link>
            </div>
            <TeamAccount />
          </div>
        </div>

        <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {CARDS.map((c) => (
            <div
              key={c.key}
              className="rounded-xl border border-emerald-100 bg-[#EFF3F8] p-4 shadow-sm"
            >
              <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
                {c.label}
              </p>
              <p className="mt-1 text-3xl font-bold text-emerald-950">
                {(data.stats as Record<string, number>)[c.key] ?? 0}
              </p>
            </div>
          ))}
        </div>

        {data.stats.total === 0 ? (
          <div className="mt-8 rounded-xl border border-emerald-200 bg-[#EFF3F8] p-6">
            <h2 className="text-lg font-semibold text-emerald-950">
              No leads yet
            </h2>
            <p className="mt-2 text-sm text-gray-600">
              The lead store is empty. Add your first prospect with{" "}
              <code className="rounded bg-emerald-100 px-1">
                POST /api/leads
              </code>{" "}
              including at least a company_name.
            </p>
          </div>
        ) : (
          <>
            <section className="mt-10">
              <h2 className="text-lg font-semibold text-emerald-950">
                Top leads by score
              </h2>
              {/* On phones the two widest columns (Type, Response) step aside so
                  Company/Status/Score/Tier fit without sideways scrolling; from
                  sm up the full six-column table is unchanged. */}
              <div className="mt-3 overflow-x-auto rounded-xl border border-emerald-100 bg-[#EFF3F8] shadow-sm">
                <table className="w-full text-left text-sm sm:min-w-[640px]">
                  <thead>
                    <tr className="border-b border-emerald-100 text-xs uppercase tracking-wide text-gray-500">
                      <th className="px-4 py-2">Company</th>
                      <th className="hidden px-4 py-2 sm:table-cell">Type</th>
                      <th className="px-4 py-2">Status</th>
                      <th className="px-4 py-2">Score</th>
                      <th className="px-4 py-2">Tier</th>
                      <th className="hidden px-4 py-2 sm:table-cell">Response</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topLeads.map((l) => (
                      <tr
                        key={l.id}
                        className="border-b border-emerald-50 last:border-0"
                      >
                        <td className="px-4 py-2 font-medium text-emerald-950">
                          {l.company_name}
                          {l.city ? (
                            <span className="ml-1 font-normal text-gray-500">
                              · {l.city}
                            </span>
                          ) : null}
                        </td>
                        <td className="hidden px-4 py-2 text-gray-600 sm:table-cell">
                          {l.lead_type ?? "—"}
                        </td>
                        <td className="px-4 py-2 text-gray-600">
                          {l.lead_status ?? "—"}
                        </td>
                        <td className="px-4 py-2 font-semibold">
                          {l.lead_score}
                        </td>
                        <td className="px-4 py-2">{tierBadge(l.score_tier)}</td>
                        <td className="hidden px-4 py-2 text-gray-600 sm:table-cell">
                          {l.response_classification ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="mt-10">
              <h2 className="text-lg font-semibold text-emerald-950">
                Follow-up queue — due now
                {data.dueQueue.length > 0 ? (
                  <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-sm font-semibold text-red-700">
                    {data.dueQueue.length}
                  </span>
                ) : null}
              </h2>
              <p className="mt-1 text-sm text-gray-600">
                Day 0 initial → Day 3 → Day 7 → Day 14 final, counted from each
                lead&apos;s first contact. Most overdue first.
              </p>
              {data.dueQueue.length === 0 ? (
                <p className="mt-2 text-sm text-gray-600">
                  Nothing due right now. Log a contact on the{" "}
                  <Link to="/leads" className="font-medium text-emerald-700 underline">
                    leads page
                  </Link>{" "}
                  and the next follow-up date appears here automatically.
                </p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {data.dueQueue.map((q) => (
                    <li
                      key={q.id}
                      className="rounded-xl border border-emerald-100 bg-[#EFF3F8] p-4 text-sm shadow-sm"
                    >
                      {/* One lead's name, step and due date. On a phone each
                          piece stacks on its own line (no awkward mid-name
                          wrapping); from sm up they sit inline as before. */}
                      <p>
                        <span className="block font-medium break-words text-emerald-950 sm:inline">
                          {q.company_name}
                          {q.city ? (
                            <span className="ml-1 font-normal text-gray-500">
                              · {q.city}
                            </span>
                          ) : null}
                        </span>
                        <span className="mt-0.5 block break-words text-gray-600 sm:mt-0 sm:ml-2 sm:inline">
                          {q.stepLabel} (Day {q.stepDay})
                          {q.nextDueDate ? ` · due ${q.nextDueDate}` : ""}
                        </span>
                      </p>
                      <p className="mt-1 break-words text-gray-600">
                        {q.nextAction}
                      </p>
                      <p className="mt-1 break-words text-xs text-gray-500">
                        Last contact: {q.last_contact_date ?? "—"} · touches
                        logged: {q.follow_up_count}
                        {q.response_classification
                          ? ` · response: ${q.response_classification}`
                          : ""}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
}
