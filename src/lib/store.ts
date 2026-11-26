/**
 * Trust Care Agency — $0 file-based JSON lead store (SERVER-SIDE ONLY).
 *
 * No database, no Neon, no DATABASE_URL, no paid services. Leads live in a
 * single JSON file on the workspace disk (durable across restarts/publishes):
 *
 *   <site>/data/leads.json            (override with LEADS_STORE_FILE)
 *
 * Writes are atomic-ish: the full array is written to a temp file and then
 * renamed over the target, so a crash mid-write never leaves half a file.
 * All I/O here is synchronous (node:fs) — the production server is a single
 * Bun process, so a sync read-modify-write inside one handler cannot
 * interleave with another.
 *
 * SEEDING: on first load — when the JSON file is missing, unreadable, or
 * holds zero leads — the store auto-imports /home/team/shared/leads-chicago.csv
 * (override with LEADS_SEED_CSV) as the initial dataset: one record per CSV
 * row, deduped on company_name + zip, each scored with src/lib/scoring.ts.
 * No manual import step, no DATABASE_URL. Once the JSON file has leads, the
 * seed is never applied again (reboots/republishes keep staff edits).
 *
 * NEVER import this module from client code — node:fs only runs on the
 * server (API routes, createServerFn handlers).
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { scoreLead } from "./scoring";

/** One lead record — the CSV columns plus id/timestamps/score tier. */
export interface LeadRecord {
  id: number;
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
  created_at: string;
  updated_at: string;
}

/** Fields a create/update payload may carry (everything but id/timestamps). */
export type LeadPatch = Partial<
  Omit<LeadRecord, "id" | "created_at" | "updated_at">
>;

export interface LeadFilters {
  lead_status?: string | null;
  lead_type?: string | null;
  score_tier?: string | null;
  response_classification?: string | null;
  /** YYYY-MM-DD: keep leads whose next_follow_up_date is on/before this. */
  due_before?: string | null;
}

const KNOWN_SITE_DIR = "/home/team/shared/site";

function detectSiteDir(): string {
  const cwd = process.cwd();
  try {
    // The dev/build cwd is the site root (has src + package.json). The
    // bundled production server is also started from the site root
    // (publish.sh cds there), but fall back to the known path if not.
    if (existsSync(join(cwd, "src", "lib", "store.ts"))) return cwd;
    if (existsSync(join(cwd, "package.json")) && existsSync(join(cwd, "src")))
      return cwd;
  } catch {
    // fall through to known path
  }
  return KNOWN_SITE_DIR;
}

const SITE_DIR = detectSiteDir();
const STORE_FILE =
  process.env.LEADS_STORE_FILE ?? join(SITE_DIR, "data", "leads.json");
const SEED_CANDIDATES = [
  process.env.LEADS_SEED_CSV ?? "",
  "/home/team/shared/leads-chicago.csv",
  join(SITE_DIR, "data", "leads-chicago.csv"),
].filter((p) => p !== "");

const TEXT_KEYS = [
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
  "score_tier",
  "response_classification",
  "first_contact_date",
  "last_contact_date",
  "next_follow_up_date",
  "notes",
] as const;

function textOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s === "" ? null : s.slice(0, 2000);
}

function intOrNull(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  const s = String(value).trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isInteger(n) ? n : null;
}

function dateOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/** Coerce an unknown parsed object into a valid record (fills gaps w/ null). */
function normalizeRecord(raw: unknown, fallbackId: number): LeadRecord {
  const r = (raw ?? {}) as Record<string, unknown>;
  const now = new Date().toISOString();
  const rec: LeadRecord = {
    id: intOrNull(r.id) ?? fallbackId,
    company_name: textOrNull(r.company_name),
    address: textOrNull(r.address),
    city: textOrNull(r.city),
    state: textOrNull(r.state),
    zip: textOrNull(r.zip),
    website: textOrNull(r.website),
    contact_name: textOrNull(r.contact_name),
    contact_role: textOrNull(r.contact_role),
    email: textOrNull(r.email),
    phone: textOrNull(r.phone),
    lead_type: textOrNull(r.lead_type),
    lead_status: textOrNull(r.lead_status) ?? "New",
    lead_score: intOrNull(r.lead_score),
    score_tier: textOrNull(r.score_tier),
    response_classification: textOrNull(r.response_classification),
    first_contact_date: dateOrNull(r.first_contact_date),
    last_contact_date: dateOrNull(r.last_contact_date),
    next_follow_up_date: dateOrNull(r.next_follow_up_date),
    follow_up_count: intOrNull(r.follow_up_count) ?? 0,
    notes: textOrNull(r.notes),
    created_at:
      typeof r.created_at === "string" && r.created_at.trim() !== ""
        ? r.created_at
        : now,
    updated_at:
      typeof r.updated_at === "string" && r.updated_at.trim() !== ""
        ? r.updated_at
        : now,
  };
  if (rec.id <= 0) rec.id = fallbackId;
  return rec;
}

/** Minimal RFC-4180 CSV parser: quoted fields, embedded commas/quotes/CRLF. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\r") {
      // skip; \n handles the break
    } else if (ch === "\n") {
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.length > 1 || row[0] !== "") rows.push(row);
  return rows;
}

function dedupeKey(company: string | null, zip: string | null): string {
  return `${(company ?? "").trim().toLowerCase()}|${(zip ?? "").trim()}`;
}

/** Recompute lead_score + score_tier from the record's own fields. */
export function applyScore<T extends LeadPatch>(rec: T): T {
  const { score, tier } = scoreLead({
    lead_type: (rec as Record<string, unknown>).lead_type as string | null,
    lead_status: (rec as Record<string, unknown>).lead_status as string | null,
    contact_name: (rec as Record<string, unknown>)
      .contact_name as string | null,
    contact_role: (rec as Record<string, unknown>)
      .contact_role as string | null,
    email: (rec as Record<string, unknown>).email as string | null,
    phone: (rec as Record<string, unknown>).phone as string | null,
    website: (rec as Record<string, unknown>).website as string | null,
    follow_up_count: (rec as Record<string, unknown>)
      .follow_up_count as number | null,
  });
  (rec as Record<string, unknown>).lead_score = score;
  (rec as Record<string, unknown>).score_tier = tier;
  return rec;
}

/** Build scored records from raw CSV text (no disk writes). */
function recordsFromCsv(text: string, startId: number): LeadRecord[] {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = parseCsv(clean);
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim());
  const idx: Record<string, number> = {};
  header.forEach((h, i) => {
    idx[h] = i;
  });
  const get = (cells: string[], col: string): string =>
    (cells[idx[col]] ?? "").trim();
  const now = new Date().toISOString();
  const out: LeadRecord[] = [];
  const seen = new Set<string>();
  let id = startId;
  for (const cells of rows.slice(1)) {
    const company = get(cells, "company_name");
    if (!company) continue;
    const zipRaw = get(cells, "zip");
    const key = dedupeKey(company, zipRaw);
    if (seen.has(key)) continue;
    seen.add(key);
    const status = get(cells, "lead_status") || "New";
    const rec: LeadRecord = {
      id: id++,
      company_name: company,
      address: get(cells, "address") || null,
      city: get(cells, "city") || null,
      state: get(cells, "state") || null,
      zip: zipRaw || null,
      website: get(cells, "website") || null,
      contact_name: get(cells, "contact_name") || null,
      contact_role: get(cells, "contact_role") || null,
      email: get(cells, "email") || null,
      phone: get(cells, "phone") || null,
      lead_type: get(cells, "lead_type") || null,
      lead_status: status,
      lead_score: null,
      score_tier: null,
      response_classification: get(cells, "response_classification") || null,
      first_contact_date: null,
      last_contact_date: null,
      next_follow_up_date: null,
      follow_up_count: (() => {
        const n = Number(get(cells, "follow_up_count"));
        return Number.isInteger(n) && n >= 0 ? n : 0;
      })(),
      notes: get(cells, "notes") || null,
      created_at: now,
      updated_at: now,
    };
    const last = get(cells, "last_contact_date").slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(last)) rec.last_contact_date = last;
    const next = get(cells, "next_follow_up_date").slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(next)) rec.next_follow_up_date = next;
    applyScore(rec);
    out.push(rec);
  }
  return out;
}

function readStoreFile(): LeadRecord[] | null {
  try {
    if (!existsSync(STORE_FILE)) return null;
    const parsed: unknown = JSON.parse(readFileSync(STORE_FILE, "utf8"));
    if (!Array.isArray(parsed)) return null;
    return parsed.map((r, i) => normalizeRecord(r, i + 1));
  } catch {
    return null;
  }
}

/** Atomic-ish write: temp file + rename, so crashes never leave half a file. */
export function saveLeads(leads: LeadRecord[]): void {
  mkdirSync(dirname(STORE_FILE), { recursive: true });
  const tmp = `${STORE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(leads, null, 2), "utf8");
  renameSync(tmp, STORE_FILE);
}

function findSeedCsv(): string | null {
  for (const p of SEED_CANDIDATES) {
    try {
      if (p && existsSync(p)) return p;
    } catch {
      // try next candidate
    }
  }
  return null;
}

/**
 * Load all leads. Auto-seeds from the 40-row Chicago CSV when the JSON file
 * is missing/empty/unreadable (idempotent: never runs when leads exist).
 */
export function loadLeads(): LeadRecord[] {
  const existing = readStoreFile();
  if (existing && existing.length > 0) return existing;
  const csvPath = findSeedCsv();
  const seeded =
    csvPath !== null
      ? recordsFromCsv(readFileSync(csvPath, "utf8"), 1)
      : [];
  saveLeads(seeded);
  return seeded;
}

/**
 * Idempotent CSV upsert into the existing store (used by
 * scripts/import-leads.ts): rows whose company_name + zip already exist are
 * skipped, never duplicated; new rows are scored on the way in.
 */
export function importCsvIntoStore(csvPath?: string): {
  total: number;
  inserted: number;
  skipped: number;
  csvPath: string | null;
} {
  const resolved =
    csvPath && csvPath.trim() !== "" ? csvPath : findSeedCsv();
  if (resolved === null || !existsSync(resolved)) {
    return { total: 0, inserted: 0, skipped: 0, csvPath: null };
  }
  const current = loadLeads();
  const seen = new Set(current.map((l) => dedupeKey(l.company_name, l.zip)));
  let id = current.reduce((m, l) => Math.max(m, l.id), 0) + 1;
  const incoming = recordsFromCsv(readFileSync(resolved, "utf8"), id);
  let inserted = 0;
  let skipped = 0;
  for (const rec of incoming) {
    const key = dedupeKey(rec.company_name, rec.zip);
    if (seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);
    rec.id = id++;
    current.push(rec);
    inserted++;
  }
  saveLeads(current);
  return { total: current.length, inserted, skipped, csvPath: resolved };
}

function sortNewestFirst(leads: LeadRecord[]): LeadRecord[] {
  return [...leads].sort((a, b) =>
    b.updated_at !== a.updated_at
      ? b.updated_at.localeCompare(a.updated_at)
      : b.id - a.id,
  );
}

/** List leads with optional exact-match filters (all filters AND together). */
export function listLeads(filters: LeadFilters = {}): LeadRecord[] {
  const match = (field: keyof LeadFilters, value: string | null): boolean => {
    const f = filters[field];
    if (f === undefined || f === null || f === "") return true;
    return (value ?? "") === f;
  };
  return sortNewestFirst(
    loadLeads().filter(
      (l) =>
        match("lead_status", l.lead_status) &&
        match("lead_type", l.lead_type) &&
        match("score_tier", l.score_tier) &&
        match("response_classification", l.response_classification) &&
        (filters.due_before === undefined ||
          filters.due_before === null ||
          filters.due_before === "" ||
          (l.next_follow_up_date !== null &&
            l.next_follow_up_date <= filters.due_before)),
    ),
  );
}

export function getLead(id: number): LeadRecord | null {
  return loadLeads().find((l) => l.id === id) ?? null;
}

/** Create a lead: assigns id + timestamps, (re)computes score/tier, saves. */
export function createLead(input: LeadPatch): LeadRecord {
  const leads = loadLeads();
  const now = new Date().toISOString();
  const rec: LeadRecord = {
    id: leads.reduce((m, l) => Math.max(m, l.id), 0) + 1,
    company_name: textOrNull(input.company_name),
    address: textOrNull(input.address),
    city: textOrNull(input.city),
    state: textOrNull(input.state),
    zip: textOrNull(input.zip),
    website: textOrNull(input.website),
    contact_name: textOrNull(input.contact_name),
    contact_role: textOrNull(input.contact_role),
    email: textOrNull(input.email),
    phone: textOrNull(input.phone),
    lead_type: textOrNull(input.lead_type),
    lead_status: textOrNull(input.lead_status) ?? "New",
    lead_score: null,
    score_tier: null,
    response_classification: textOrNull(input.response_classification),
    first_contact_date: dateOrNull(input.first_contact_date),
    last_contact_date: dateOrNull(input.last_contact_date),
    next_follow_up_date: dateOrNull(input.next_follow_up_date),
    follow_up_count: intOrNull(input.follow_up_count) ?? 0,
    notes: textOrNull(input.notes),
    created_at: now,
    updated_at: now,
  };
  applyScore(rec);
  leads.push(rec);
  saveLeads(leads);
  return rec;
}

/**
 * Update a lead: only keys present in `patch` are touched,
 * score/tier are recomputed, updated_at refreshed. Null = not found.
 */
export function updateLeadRecord(
  id: number,
  patch: LeadPatch,
): LeadRecord | null {
  const leads = loadLeads();
  const rec = leads.find((l) => l.id === id) ?? null;
  if (!rec) return null;
  for (const key of TEXT_KEYS) {
    if ((patch as Record<string, unknown>)[key] !== undefined) {
      (rec as unknown as Record<string, unknown>)[key] = textOrNull(
        (patch as Record<string, unknown>)[key],
      );
    }
  }
  if (patch.first_contact_date !== undefined)
    rec.first_contact_date = dateOrNull(patch.first_contact_date);
  if (patch.last_contact_date !== undefined)
    rec.last_contact_date = dateOrNull(patch.last_contact_date);
  if (patch.next_follow_up_date !== undefined)
    rec.next_follow_up_date = dateOrNull(patch.next_follow_up_date);
  if (patch.follow_up_count !== undefined)
    rec.follow_up_count = intOrNull(patch.follow_up_count) ?? 0;
  if (patch.lead_status !== undefined && rec.lead_status === null)
    rec.lead_status = "New";
  rec.updated_at = new Date().toISOString();
  applyScore(rec);
  saveLeads(leads);
  return rec;
}

/** Delete a lead. Returns false when the id does not exist. */
export function deleteLead(id: number): boolean {
  const leads = loadLeads();
  const idx = leads.findIndex((l) => l.id === id);
  if (idx === -1) return false;
  leads.splice(idx, 1);
  saveLeads(leads);
  return true;
}
