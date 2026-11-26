#!/usr/bin/env bun
/**
 * Tiny unit exerciser for the sales-agent server libs (no DB needed):
 *
 *   bun run scripts/test-sales-agent.ts
 *
 * Exercises scoreLead (scoring.ts), generateOutreach (outreach.ts), and
 * getFollowUpState (followup.ts) against three representative leads and
 * asserts the expected tiers/steps. Exits non-zero on the first failure.
 */
import { selectCalls, callStatusLine } from "../src/lib/callsheet.ts";
import type { CallLead } from "../src/lib/callsheet.ts";
import { generateOutreach } from "../src/lib/outreach.ts";
import { getFollowUpState } from "../src/lib/followup.ts";
import { scoreLead } from "../src/lib/scoring.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok: ${name}`);
  else {
    failures++;
    console.error(`  FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// 1. Fully-enriched skilled-nursing prospect, actively engaged → HOT.
const hot = scoreLead({
  lead_type: "Skilled Nursing / Rehab",
  lead_status: "Needs Staffing",
  contact_name: "Jane Smith",
  contact_role: "Director of Nursing",
  email: "jane@example.com",
  phone: "773-555-0100",
  website: "https://example.com",
  follow_up_count: 3,
});
console.log(`enriched SNF lead → ${hot.score}/${hot.tier}`, hot.breakdown);
check("enriched SNF lead is HOT", hot.tier === "HOT", `got ${hot.tier}`);
check("enriched SNF score >= 80", hot.score >= 80, `got ${hot.score}`);

// 2. Realistic seed-CSV row (name + phone + website + generic dept role,
// status New) → WARM. Mirrors e.g. Harmony Healthcare in leads-chicago.csv.
const bare = scoreLead({
  lead_type: "Skilled Nursing / Rehab",
  lead_status: "New",
  contact_name: null,
  contact_role: "Admissions / Administration",
  email: null,
  phone: "773-555-0101",
  website: "https://example.com",
  follow_up_count: 0,
});
console.log(`bare CSV row → ${bare.score}/${bare.tier}`, bare.breakdown);
check("bare row is WARM", bare.tier === "WARM", `got ${bare.tier}`);

// 3. Do-Not-Contact home-care lead with no enrichment → COLD.
const cold = scoreLead({
  lead_type: "Home Care",
  lead_status: "Do Not Contact",
  contact_name: null,
  contact_role: null,
  email: null,
  phone: null,
  website: null,
  follow_up_count: 0,
});
console.log(`do-not-contact row → ${cold.score}/${cold.tier}`, cold.breakdown);
check("DNC row is COLD", cold.tier === "COLD", `got ${cold.tier}`);

// 4. Outreach drafts personalize + stay honest.
const drafts = generateOutreach({
  company_name: "Maple Grove Rehab",
  lead_type: "Skilled Nursing / Rehab",
  city: "Chicago",
  contact_name: "Jane Smith",
  contact_role: "Director of Nursing",
});
check("initial email names the company", drafts.initialEmail.body.includes("Maple Grove Rehab"));
// The greeting addresses the named contact by FIRST name ("Hi Jane,") — that is
// what the owner's own first-touch copy does, and what the mail-app handoff
// showed in a live browser ("Hi Gus," for Gus Lopez). The stored role string is
// deliberately never used as a salutation.
check(
  "initial email greets the contact by first name",
  drafts.initialEmail.body.startsWith("Hi Jane,"),
  drafts.initialEmail.body.split("\n")[0],
);
check(
  "initial email falls back to the owner's generic salutation",
  generateOutreach({
    company_name: "Maple Grove Rehab",
    lead_type: "Skilled Nursing / Rehab",
    city: "Chicago",
  }).initialEmail.body.startsWith("Hi Administrator/Director of Nursing,"),
);
check("initial email references Trust Care Agency", drafts.initialEmail.body.includes("Trust Care Agency"));
// The owner's sign-off was completed 2026-10-26 with his phone, email and
// website: a facility that wants to reply must be able to reach him without
// hunting, so both emails have to carry all three.
for (const [label, body] of [
  ["initial", drafts.initialEmail.body],
  ["follow-up", drafts.followUpEmail.body],
] as const) {
  check(`${label} email signs off as the owner`, body.includes("Mr. G. Yeboah"));
  check(`${label} email carries the phone number`, body.includes("(815) 260-3106"));
  check(`${label} email carries the email address`, body.includes("trustcare@mail.com"));
  check(`${label} email carries the website`, body.includes("www.trustcareagency.net"));
}
check("initial email has opt-out", drafts.initialEmail.body.toLowerCase().includes("opt out"));
check("follow-up references the company", drafts.followUpEmail.body.includes("Maple Grove Rehab"));
check("call script names the company", drafts.callScript.includes("Maple Grove Rehab"));
const banned = ["urgent", "final notice", "last chance", "act now", "guarantee"];
const allText = `${drafts.initialEmail.body}\n${drafts.followUpEmail.body}\n${drafts.callScript}`.toLowerCase();
check("no manufactured urgency or guarantees", !banned.some((w) => allText.includes(w)));

// Unknown fields degrade gracefully instead of guessing.
const generic = generateOutreach({ company_name: null, lead_type: null });
check("generic draft still renders", generic.initialEmail.subject.length > 0 && generic.callScript.length > 0);
check("generic draft has no 'null' leakage", !allText.includes("null") && !`${generic.initialEmail.body}`.includes("null"));

// 5. Follow-up cadence: fresh lead → Day 0 step due now.
const fresh = getFollowUpState(
  { follow_up_count: 0, last_contact_date: null, next_follow_up_date: null, lead_status: "New", response_classification: null },
  new Date("2026-09-06T12:00:00Z"),
);
check("fresh lead is on initial step", fresh.stepIndex === 0 && fresh.stepDay === 0, JSON.stringify(fresh));
check("fresh lead is due", fresh.isDue);

// Mid-cadence: 1 touch on Sept 1 → Day 3 step due Sept 4.
const mid = getFollowUpState(
  { follow_up_count: 1, last_contact_date: "2026-09-01", next_follow_up_date: null, lead_status: "Contacted", response_classification: null },
  new Date("2026-09-06T12:00:00Z"),
);
check("mid-cadence is on Day 3 step", mid.stepDay === 3, JSON.stringify(mid));
check("mid-cadence due date is Sept 4", mid.nextDueDate === "2026-09-04", `got ${mid.nextDueDate}`);
check("mid-cadence is due", mid.isDue);

// Terminal classification stops the cadence.
const dnc = getFollowUpState(
  { follow_up_count: 2, last_contact_date: "2026-09-01", next_follow_up_date: "2026-09-05", lead_status: "Contacted", response_classification: "Do Not Contact" },
  new Date("2026-09-06T12:00:00Z"),
);
check("DNC lead is complete", dnc.isComplete);
check("DNC lead is not due", !dnc.isDue);

// Cadence exhaustion: 4 touches logged → complete.
const done = getFollowUpState(
  { follow_up_count: 4, last_contact_date: "2026-09-01", next_follow_up_date: null, lead_status: "Contacted", response_classification: null },
  new Date("2026-09-06T12:00:00Z"),
);
check("exhausted cadence is complete", done.isComplete);

/* ------------------------------------------------------------------ */
/* Today's call sheet (/calls) — selection, filters, batching          */
/* ------------------------------------------------------------------ */

/** A stored lead with sane defaults; override what a check cares about. */
function callLead(partial: Partial<CallLead> & { id: number }): CallLead {
  return {
    company_name: `Lead ${String(partial.id)}`,
    city: "Chicago",
    phone: "773-555-0100",
    email: null,
    contact_name: null,
    contact_role: null,
    lead_type: "Skilled Nursing / Rehab",
    lead_status: "New",
    lead_score: 50,
    score_tier: "WARM",
    response_classification: null,
    follow_up_count: 0,
    first_contact_date: null,
    last_contact_date: null,
    next_follow_up_date: null,
    ...partial,
  };
}

const TODAY = "2026-09-06";
const callLeads = [
  callLead({ id: 1, lead_score: 61 }), // phone-only, never contacted
  callLead({ id: 2, lead_score: 90, email: "a@example.com" }), // has email, better score
  callLead({
    id: 3,
    lead_score: 40,
    email: "c@example.com",
    contact_name: "Jane Smith",
    contact_role: "HR Director — name not verified",
  }),
  // Terminal: must never appear on a call sheet.
  callLead({ id: 4, lead_score: 95, response_classification: "Do Not Contact" }),
  // Already called today: off the sheet until tomorrow.
  callLead({
    id: 5,
    follow_up_count: 1,
    last_contact_date: TODAY,
    next_follow_up_date: "2026-09-09",
  }),
  // Overdue Day-3 follow-up: must sort to the top.
  callLead({
    id: 6,
    lead_score: 30,
    follow_up_count: 1,
    last_contact_date: "2026-08-01",
    first_contact_date: "2026-08-01",
    next_follow_up_date: "2026-08-04",
  }),
];

const sheetAll = selectCalls(callLeads, { today: TODAY });
check(
  "call sheet drops terminal leads",
  !sheetAll.pool.some(({ lead }) => lead.id === 4),
  sheetAll.pool.map(({ lead }) => lead.id).join(","),
);
check(
  "call sheet drops leads already called today",
  !sheetAll.pool.some(({ lead }) => lead.id === 5),
);
check("call sheet pool is 4 of 6 leads", sheetAll.pool.length === 4, `got ${String(sheetAll.pool.length)}`);
check(
  "call sheet chip counts are phone-only 2 / email 2 / named 1",
  sheetAll.counts.phoneOnly === 2 && sheetAll.counts.email === 2 && sheetAll.counts.named === 1,
  JSON.stringify(sheetAll.counts),
);
check(
  "call sheet puts the overdue follow-up first",
  sheetAll.ordered[0]?.lead.id === 6,
  `got ${String(sheetAll.ordered[0]?.lead.id)}`,
);
check(
  "call sheet then orders by score descending",
  sheetAll.ordered.slice(1).map(({ lead }) => lead.id).join(",") === "2,1,3",
  sheetAll.ordered.slice(1).map(({ lead }) => lead.id).join(","),
);
const phoneOnly = selectCalls(callLeads, { today: TODAY, emailFilter: "phone" });
check(
  "phone-only filter keeps only leads with no email",
  phoneOnly.ordered.every(({ lead }) => (lead.email ?? "") === "") &&
    phoneOnly.ordered.length === 2,
);
const namedOnly = selectCalls(callLeads, { today: TODAY, namedOnly: true });
check(
  "named-contact filter keeps only leads with a person's name",
  namedOnly.ordered.length === 1 && namedOnly.ordered[0]?.lead.id === 3,
);

const many = Array.from({ length: 20 }, (_, i) =>
  callLead({ id: i + 1, lead_score: 60 + i }),
);
const firstPage = selectCalls(many, { today: TODAY });
const secondPage = selectCalls(many, { today: TODAY, page: 1 });
check("call sheet batches 12 at a time", firstPage.batch.length === 12, `got ${String(firstPage.batch.length)}`);
check("call sheet second batch holds the remaining 8", secondPage.batch.length === 8);
check(
  "call sheet counter reads 12 of 20 then 20 of 20",
  firstPage.rangeEnd === 12 && secondPage.rangeEnd === 20 && secondPage.pageCount === 2,
  `${String(firstPage.rangeEnd)} / ${String(secondPage.rangeEnd)}`,
);

check(
  "status line says a fresh lead is not contacted",
  callStatusLine(sheetAll.pool.find(({ lead }) => lead.id === 1)!.lead, {
    stepIndex: 0,
    stepLabel: "Initial outreach",
    stepDay: 0,
    isFinalStep: false,
    isComplete: false,
    nextDueDate: TODAY,
    isDue: true,
    nextAction: "",
  }) === "Not contacted yet",
);
const overdueEntry = sheetAll.ordered[0]!;
check(
  "status line shows the due Day 3 follow-up",
  callStatusLine(overdueEntry.lead, overdueEntry.state).includes("Day 3 follow-up due"),
  callStatusLine(overdueEntry.lead, overdueEntry.state),
);

if (failures > 0) {
  console.error(`${failures} check(s) failed.`);
  process.exit(1);
}
console.log("All sales-agent checks passed.");
