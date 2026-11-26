/**
 * Trust Care Agency — deterministic, rule-based lead scorer (server-side only).
 *
 * No AI calls, no magic: a transparent 0–100 score = sum of small,
 * explainable weights over fields the seed CSV actually has. Every point is
 * traceable to `scoreLead` below, and the breakdown is returned alongside the
 * total so the dashboard can show *why* a lead is HOT.
 *
 * WEIGHTS (max 100):
 *   Facility-type staffing demand ............ up to +30
 *     Skilled Nursing / Rehab ................ +30  (24/7 CNA/LPN/RN coverage,
 *                                                   highest temp-staffing demand)
 *     Hospital ............................... +28  (high acuity, float-pool demand)
 *     Senior Living / Skilled Nursing ........ +25
 *     Senior Living / Rehab .................. +25
 *     Home Health / Home Care ................ +22  (steady caregiver demand)
 *     Home Care .............................. +20
 *     Home Care / Staffing ................... +20
 *     unknown / other ........................ +12
 *   Reachability (can we actually contact them?) up to +25
 *     public business email present .......... +12
 *     direct phone present ................... +8
 *     website present ........................ +5
 *   Decision-maker contact ................... up to +20
 *     named contact (contact_name set) ....... +10
 *     staffing-relevant role ................. +10  (role text mentions HR, DON,
 *       director of nursing, staffing, recruiter, administrator, admissions)
 *     generic contact only (no name) ......... +3   (partial credit — a warm
 *       number/department beats nothing)
 *   Engagement state ......................... up to +15
 *     lead_status Contacted .................. +8   (in active outreach)
 *     lead_status Interested / Needs Staffing  +15  (raised a hand)
 *     lead_status Appointment / Converted .... +15  (already progressing)
 *     lead_status New ........................ +5   (fresh, untouched)
 *     lead_status Not Interested / Do Not Contact / Bad Contact ... 0
 *   Follow-up momentum ....................... up to +10
 *     follow_up_count >= 3 ................... +10
 *     follow_up_count 1–2 .................... +5
 *     follow_up_count 0 ...................... +2   (untried = still opportunity)
 *
 * TIERS:  HOT 80–100 · WARM 50–79 · COLD 0–49.
 * A fully-enriched, actively-engaged skilled-nursing facility lands ~90+;
 * a bare CSV row (name + phone only, no email/contact, status New) lands ~50s;
 * a "Do Not Contact" lead with no enrichment lands in the 30s or below.
 */

export type ScoreTier = "HOT" | "WARM" | "COLD";

export interface ScoreBreakdown {
  typeDemand: number;
  reachability: number;
  contact: number;
  engagement: number;
  momentum: number;
}

export interface ScoreResult {
  score: number;
  tier: ScoreTier;
  breakdown: ScoreBreakdown;
}

/** Minimal shape the scorer needs — a subset of the leads row. */
export interface ScorableLead {
  lead_type?: string | null;
  lead_status?: string | null;
  contact_name?: string | null;
  contact_role?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  follow_up_count?: number | null;
}

const STAFFING_ROLE_RE = /hr|human resources|don|director of nursing|staffing|recruit|administrator|admissions|nursing director/i;

export function typeDemandPoints(leadType: string | null | undefined): number {
  const t = (leadType ?? "").toLowerCase();
  if (!t.trim()) return 12;
  if (t.includes("skilled nursing") && t.includes("rehab")) return 30;
  if (t.includes("hospital")) return 28;
  if (t.includes("senior living")) return 25;
  if (t.includes("home health")) return 22;
  if (t.includes("home care")) return 20;
  return 12;
}

export function reachabilityPoints(lead: ScorableLead): number {
  let pts = 0;
  if (lead.email && String(lead.email).trim() !== "") pts += 12;
  if (lead.phone && String(lead.phone).trim() !== "") pts += 8;
  if (lead.website && String(lead.website).trim() !== "") pts += 5;
  return pts;
}

export function contactPoints(lead: ScorableLead): number {
  const hasName =
    !!lead.contact_name && String(lead.contact_name).trim() !== "";
  const role = String(lead.contact_role ?? "");
  if (hasName && STAFFING_ROLE_RE.test(role)) return 20;
  if (hasName) return 10;
  if (role.trim() !== "") return 3;
  return 0;
}

export function engagementPoints(status: string | null | undefined): number {
  const s = (status ?? "").trim().toLowerCase();
  if (s === "interested" || s === "needs staffing") return 15;
  if (s === "appointment" || s === "appointments" || s === "converted") return 15;
  if (s === "contacted") return 8;
  if (s === "new" || s === "") return 5;
  if (s === "no response") return 3;
  return 0; // Not Interested / Do Not Contact / Bad Contact / etc.
}

export function momentumPoints(count: number | null | undefined): number {
  const n = Number(count ?? 0);
  if (!Number.isFinite(n) || n <= 0) return 2;
  if (n >= 3) return 10;
  return 5;
}

export function tierForScore(score: number): ScoreTier {
  if (score >= 80) return "HOT";
  if (score >= 50) return "WARM";
  return "COLD";
}

export function scoreLead(lead: ScorableLead): ScoreResult {
  const breakdown: ScoreBreakdown = {
    typeDemand: typeDemandPoints(lead.lead_type),
    reachability: reachabilityPoints(lead),
    contact: contactPoints(lead),
    engagement: engagementPoints(lead.lead_status),
    momentum: momentumPoints(lead.follow_up_count),
  };
  const total =
    breakdown.typeDemand +
    breakdown.reachability +
    breakdown.contact +
    breakdown.engagement +
    breakdown.momentum;
  const score = Math.max(0, Math.min(100, total));
  return { score, tier: tierForScore(score), breakdown };
}
