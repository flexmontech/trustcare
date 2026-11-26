/**
 * Client-side CSV parsing for the /leads "Import CSV" panel.
 *
 * Browser-safe, dependency-free and pure: nothing here touches the store, the
 * filesystem or the network. The panel parses the pasted/uploaded text with
 * parseCsvText(), previews the rows, then POSTs each one to the existing
 * POST /api/leads (which does the real validation and scoring server-side).
 *
 * Only the eleven fields the internal Add-prospect form exposes are read:
 * company_name, address, city, state, zip, website, contact_name,
 * contact_role, email, phone, lead_type. Every other column in the file —
 * including the seed CSV's lead_status / lead_score / notes — is ignored on
 * purpose: status defaults to "New" and scores are always computed by
 * src/lib/scoring.ts on the server, never taken from a spreadsheet.
 */

export const IMPORT_COLUMNS = [
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
] as const;

export type ImportColumn = (typeof IMPORT_COLUMNS)[number];

/** Human labels for the preview / summary lines. */
export const IMPORT_LABELS: Record<ImportColumn, string> = {
  company_name: "Company name",
  address: "Address",
  city: "City",
  state: "State",
  zip: "ZIP",
  website: "Website",
  contact_name: "Contact name",
  contact_role: "Contact role",
  email: "Email",
  phone: "Phone",
  lead_type: "Facility type",
};

/**
 * Header names accepted in addition to the canonical ones above (which are
 * always accepted, case-insensitively). Anything else is ignored.
 * Deliberately no bare "name" alias — it is ambiguous between company and
 * contact name, and guessing there would put a person's name in the company
 * column.
 */
const HEADER_ALIASES: Record<string, ImportColumn> = {
  company: "company_name",
  organization: "company_name",
  organization_name: "company_name",
  facility: "company_name",
  facility_name: "company_name",
  street: "address",
  street_address: "address",
  address_line_1: "address",
  town: "city",
  st: "state",
  zip_code: "zip",
  zipcode: "zip",
  postal_code: "zip",
  url: "website",
  web: "website",
  contact: "contact_name",
  contact_person: "contact_name",
  role: "contact_role",
  title: "contact_role",
  email_address: "email",
  phone_number: "phone",
  telephone: "phone",
  tel: "phone",
  facility_type: "lead_type",
  type: "lead_type",
};

/** Guard rail so a mis-picked file cannot hammer the API for minutes. */
export const MAX_IMPORT_ROWS = 500;

export interface ParsedCsvRow {
  /** 1-based line number in the file, header included — the "row 12" staff see. */
  line: number;
  /** Only the recognised columns, trimmed. Empty string = blank cell. */
  values: Record<ImportColumn, string>;
}

export interface ParsedCsv {
  /** Canonical columns actually found in the header, in IMPORT_COLUMNS order. */
  columns: ImportColumn[];
  rows: ParsedCsvRow[];
  /** Set when the file cannot be imported at all; rows is then empty. */
  error: string | null;
  /** True when the file had more data rows than MAX_IMPORT_ROWS (extra dropped). */
  truncated: boolean;
}

interface RawRow {
  line: number;
  cells: string[];
}

function normalizeHeaderCell(raw: string): string {
  return raw
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

/** Minimal RFC-4180 tokenizer: quoted fields, "" escapes, CRLF or LF, BOM. */
function tokenize(text: string): RawRow[] {
  const rows: RawRow[] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let line = 1;
  let rowStartLine = 1;

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
        if (ch === "\n") line++;
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\r") {
      // ignore; the \n (if any) ends the row
    } else if (ch === "\n") {
      row.push(field);
      field = "";
      rows.push({ line: rowStartLine, cells: row });
      row = [];
      line++;
      rowStartLine = line;
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push({ line: rowStartLine, cells: row });
  }
  return rows;
}

const isBlankRow = (cells: string[]): boolean =>
  cells.every((c) => c.trim() === "");

/**
 * Parse CSV text into recognised rows. Never throws: an unimportable file
 * comes back as { error } so the panel can show a plain-English message.
 */
export function parseCsvText(text: string): ParsedCsv {
  const empty: ParsedCsv = {
    columns: [],
    rows: [],
    error: null,
    truncated: false,
  };
  if (text.trim() === "")
    return { ...empty, error: "Paste some CSV text or choose a .csv file first." };

  const raw = tokenize(text.replace(/^\uFEFF/, ""));
  const headerIndex = raw.findIndex((r) => !isBlankRow(r.cells));
  if (headerIndex === -1)
    return { ...empty, error: "That file has no rows in it." };

  const header = raw[headerIndex].cells.map(normalizeHeaderCell);
  const byColumn = new Map<ImportColumn, number>();
  header.forEach((cell, i) => {
    const canonical =
      (IMPORT_COLUMNS as readonly string[]).includes(cell)
        ? (cell as ImportColumn)
        : HEADER_ALIASES[cell];
    if (canonical && !byColumn.has(canonical)) byColumn.set(canonical, i);
  });

  if (!byColumn.has("company_name"))
    return {
      ...empty,
      error:
        "No company_name column found in the header. The first line must be column names, e.g. company_name,address,city,state,zip,website,contact_name,contact_role,email,phone,lead_type",
    };

  const columns = IMPORT_COLUMNS.filter((c) => byColumn.has(c));

  const dataRows = raw
    .slice(headerIndex + 1)
    .filter((r) => !isBlankRow(r.cells));

  if (dataRows.length === 0)
    return { ...empty, columns, error: "The header is there but there are no data rows below it." };

  const truncated = dataRows.length > MAX_IMPORT_ROWS;
  const rows: ParsedCsvRow[] = dataRows
    .slice(0, MAX_IMPORT_ROWS)
    .map((r) => {
      const values = {} as Record<ImportColumn, string>;
      for (const col of IMPORT_COLUMNS) {
        const idx = byColumn.get(col);
        values[col] = idx === undefined ? "" : (r.cells[idx] ?? "").trim();
      }
      return { line: r.line, values };
    });

  return { columns, rows, error: null, truncated };
}

/**
 * Duplicate identity: company name + city, case- and whitespace-insensitive.
 * Two rows with the same pair are treated as the same facility (a second copy
 * of a lead helps nobody and doubles the follow-up work).
 */
export function leadKey(
  company: string | null | undefined,
  city: string | null | undefined,
): string {
  const norm = (v: string | null | undefined): string =>
    (v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return `${norm(company)}|${norm(city)}`;
}

/** Build the POST /api/leads body from a parsed row (recognised columns only). */
export function rowToLeadBody(
  values: Record<ImportColumn, string>,
): Record<string, string> {
  const body: Record<string, string> = {};
  for (const col of IMPORT_COLUMNS) {
    const v = values[col];
    if (v !== undefined && v !== "") body[col] = v;
  }
  return body;
}
