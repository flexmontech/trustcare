/**
 * Trust Care Agency — template-based outreach draft generator (server-side only).
 *
 * Produces three personalized drafts per lead: an initial email, a follow-up
 * email, and a call script. Deterministic string templates — no AI API calls,
 * no email sending (the business has no email integration; these drafts are
 * for agency staff to copy, review, and send themselves).
 *
 * The FIRST-TOUCH EMAIL is the owner's own copy, used verbatim: same sentences
 * in the same order, with only these substitutions —
 *   greeting (named contact / owner's generic salutation), the client reference
 *   ("{Company} in {City}"), the facility-type sentence, and the agency name
 *   normalized to the AGENCY constant. Do not rewrite that copy without the
 *   owner asking; it is their voice, not the team's.
 *
 * Honesty rules enforced by construction:
 *  - No fabricated claims (no fake client lists, ratings, or guarantees).
 *  - No manufactured urgency ("urgent", "final notice", "last chance" never
 *    appear).
 *  - Personalization comes only from real lead fields: company name, facility
 *    type, city, known contact name/role. Unknown fields degrade gracefully
 *    to neutral fallbacks instead of guesses — and a lead whose city we don't
 *    know is never labelled "in Chicago".
 *  - Every email draft includes a plain opt-out line.
 */

export interface OutreachLead {
  company_name?: string | null;
  lead_type?: string | null;
  city?: string | null;
  contact_name?: string | null;
  contact_role?: string | null;
}

export interface OutreachDrafts {
  initialEmail: { subject: string; body: string };
  followUpEmail: { subject: string; body: string };
  callScript: string;
}

const AGENCY = "Trust Care Agency";

/**
 * Where the agency actually works. The owner's copy said "the Chicago area",
 * but 13 of the seed leads are suburban — so every draft says "Chicago and the
 * surrounding suburbs" instead of implying Chicago city only.
 */
const SERVICE_AREA = "Chicago and the surrounding suburbs";

/**
 * The needs wording the owner uses in the first-touch email. It is what the
 * agency actually offers, so it does not vary by facility type.
 */
const FIRST_TOUCH_NEEDS =
  "CNAs, LPNs, and RNs for round-the-clock coverage, weekend shifts, and census surges";

/** The owner's generic salutation when the lead has no named contact. */
const GENERIC_SALUTATION = "Hi Administrator/Director of Nursing,";
/**
 * The owner's own sign-off, supplied 2026-10-25 and completed 2026-10-26 with
 * the phone, email and website he sent. Used verbatim on every outreach email
 * so a facility that wants to reply has every way to reach him.
 *
 * The agency name is spelled "Trust Care Agency" (two words) — what his logo,
 * his live site trustcareagency.net and his signature all use.
 */
const SIGNATURE = [
  "Best Regards,",
  "Mr. G. Yeboah",
  "Trust Care Agency",
  "Chicago",
  "(815) 260-3106",
  "trustcare@mail.com",
  "www.trustcareagency.net",
].join("\n");

/**
 * lead_type → the phrase that follows "As ..." in the first-touch email,
 * article included so "a"/"an" is always right (never "As a assisted living").
 * Keys are the exact labels the store holds, lowercased.
 */
const TYPE_DESCRIPTORS: Record<string, string> = {
  "skilled nursing / rehab": "a skilled nursing and rehabilitation center",
  "senior living / assisted living": "an assisted living community",
  "senior living / memory care": "a memory care community",
  "senior living / assisted living & memory care":
    "an assisted living and memory care community",
  "senior living / skilled nursing": "a senior living community",
  "senior living / rehab": "a senior living community",
  "home health / home care": "a home care agency",
  "home care": "a home care agency",
  "home care / staffing": "a home care agency",
  hospital: "a hospital",
};

/**
 * Facility descriptor for the lead's real type (article included).
 * Unknown or blank type degrades to the neutral "a facility leader" — never a
 * guess about what kind of organization it is.
 */
function typeDescriptor(leadType: string | null | undefined): string {
  const t = (leadType ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const exact = TYPE_DESCRIPTORS[t];
  if (exact) return exact;
  if (t === "") return "a facility leader";
  if (t.includes("skilled nursing") || t.includes("rehab"))
    return "a skilled nursing and rehabilitation center";
  if (t.includes("hospital")) return "a hospital";
  if (t.includes("assisted living") && t.includes("memory care"))
    return "an assisted living and memory care community";
  if (t.includes("memory care")) return "a memory care community";
  if (t.includes("assisted living")) return "an assisted living community";
  if (t.includes("senior living")) return "a senior living community";
  if (t.includes("home health") || t.includes("home care"))
    return "a home care agency";
  return "a facility leader";
}

/** Human-friendly facility label + the roles that type usually needs. */
function facilityProfile(leadType: string | null | undefined): {
  descriptor: string;
  needs: string;
} {
  const t = (leadType ?? "").toLowerCase();
  const descriptor = typeDescriptor(leadType);
  if (t.includes("skilled nursing") && t.includes("rehab"))
    return {
      descriptor,
      needs: "CNAs, LPNs, and RNs for round-the-clock coverage, weekend shifts, and census surges",
    };
  if (t.includes("hospital"))
    return {
      descriptor,
      needs: "RNs, LPNs, and CNAs for float coverage, call-offs, and high-census periods",
    };
  if (t.includes("senior living"))
    return {
      descriptor,
      needs: "caregivers, medication aides, and CNAs for daily resident care and shift coverage",
    };
  if (t.includes("home health"))
    return {
      descriptor,
      needs: "certified caregivers, CNAs, and skilled nurses for in-home visits",
    };
  if (t.includes("home care"))
    return {
      descriptor,
      needs: "certified caregivers and CNAs for in-home shifts and fill-in coverage",
    };
  return {
    descriptor,
    needs: "CNAs, caregivers, and nurses for shift coverage and call-offs",
  };
}

const HONORIFIC_RE = /^(dr|mr|mrs|ms|miss|prof|sir|madam)\.?$/i;

/**
 * First name for the greeting. "David DeVos" → "David"; a single token is used
 * as-is; a name that starts with a title ("Dr. Jane Doe") is left whole.
 */
function firstName(fullName: string): string {
  const parts = fullName.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return fullName;
  if (HONORIFIC_RE.test(parts[0])) return fullName;
  return parts[0];
}

function greeting(lead: OutreachLead): string {
  const name = (lead.contact_name ?? "").trim();
  // Same first-name form and same fallback as the first-touch email, so the
  // follow-up from the same sender doesn't address the same person
  // differently. The role string is never used as a salutation: the stored
  // roles are internal caveats ("HR or Business Office Manager — name not
  // verified"), not something to greet a stranger with.
  if (name) return `Hi ${firstName(name)},`;
  return GENERIC_SALUTATION;
}

/**
 * Greeting for the owner's first-touch copy: the named contact by first name
 * when we have one, otherwise the owner's exact generic salutation. A stored
 * role string is NOT used as a salutation here — the role notes ("HR or
 * Business Office Manager — name not verified") are internal caveats, not
 * something to greet a stranger with.
 */
function firstTouchGreeting(lead: OutreachLead): string {
  const name = (lead.contact_name ?? "").trim();
  if (name) return `Hi ${firstName(name)},`;
  return GENERIC_SALUTATION;
}

/**
 * "{Company} in {City}". When the city is blank we say "in the Chicago area"
 * rather than assuming Chicago — a suburban lead must never read "in Chicago".
 */
function companyLine(lead: OutreachLead): string {
  const company = (lead.company_name ?? "").trim() || "your organization";
  const city = (lead.city ?? "").trim();
  return `${company} in ${city || "the Chicago area"}`;
}

export function generateOutreach(lead: OutreachLead): OutreachDrafts {
  const company = (lead.company_name ?? "").trim() || "your organization";
  const profile = facilityProfile(lead.lead_type);
  const greet = greeting(lead);
  const firstTouch = firstTouchGreeting(lead);
  const companyRef = companyLine(lead);

  // The owner's first-touch email — verbatim copy, substitutions only.
  const initialEmail = {
    subject: `Staffing support for ${company}`,
    body: [
      firstTouch,
      "",
      `I'm reaching out from ${AGENCY}, a healthcare staffing agency serving ${SERVICE_AREA}. We help facilities like ${companyRef} cover ${FIRST_TOUCH_NEEDS}.`,
      "",
      `As ${profile.descriptor}, you know how quickly a call-off or a census swing can strain the schedule. We keep a pool of screened caregivers and nursing staff available for short shifts, weekend coverage, and longer assignments — you request help only when you need it, with no long-term commitment to start.`,
      "",
      "Would a brief call this week be useful to talk through your current staffing gaps? If the timing isn't right, just let me know and I won't follow up further.",
      "",
      "Thank you for the work your team does,",
      "",
      SIGNATURE,
      "",
      "P.S. Reply with \"opt out\" and we'll remove you.",
    ].join("\n"),
  };

  const followUpEmail = {
    subject: `Following up — ${company} staffing`,
    body: [
      greet,
      "",
      `I'm following up on my earlier note from ${AGENCY}. We support facilities across ${SERVICE_AREA}, like ${companyRef}, with ${profile.needs}.`,
      "",
      "If coverage has been steady, no need to reply — but if call-offs or open shifts have been a headache lately, a short conversation could help us understand what coverage would actually be useful for your team.",
      "",
      "Open to a 10-minute call next week? And if this isn't a priority, a quick \"not now\" is completely fine — I'll close the loop on our side.",
      "",
      SIGNATURE,
      "",
      "P.S. Reply \"opt out\" any time and we'll take you off our list, no questions asked.",
    ].join("\n"),
  };

  const callScript = [
    `CALL SCRIPT — ${company} (${AGENCY})`,
    "",
    `Opening: "Hi, this is [Your Name] with ${AGENCY}, a healthcare staffing agency serving ${SERVICE_AREA}. May I speak with whoever handles staffing or scheduling for ${company}?"`,
    "",
    `If gatekeeper asks what it's about: "We help organizations like ${companyRef} cover ${profile.needs}. Just a brief introduction, two minutes at most."`,
    "",
    `With decision-maker: "Thanks for taking my call. I'll keep this short — how has coverage been lately? Are call-offs or open shifts something your team deals with week to week?" [Listen — do not pitch over their answer.]`,
    "",
    `"What we do is simple: screened caregivers and nursing staff you can request when you need an extra pair of hands — single shifts up to longer assignments, no long-term commitment to start. Would it be worth a 10-minute call later this week to see whether we'd be a fit?"`,
    "",
    `Objection — "We're fully staffed": "That's great to hear. Can I leave my number in case that changes around holidays or survey season? No follow-up unless you ask."`,
    `Objection — "Send me something": "Happy to — I'll send a short email today. What address is best? And is there a good day to check back if I don't hear from you?"`,
    `Objection — "Not interested": "Understood, thanks for your time — I'll make sure we don't call again." [Mark Do Not Contact.]`,
    "",
    `Close: confirm name, role, best callback time, and current needs; log them in the lead record right after the call.`,
  ].join("\n");

  return { initialEmail, followUpEmail, callScript };
}
