#!/usr/bin/env bun
/**
 * Import the pre-built Chicago prospect list into the $0 file-based JSON
 * store (src/lib/store.ts) — no database, no DATABASE_URL, no Neon.
 *
 *   bun run scripts/import-leads.ts [--file <path>]
 *
 * Defaults to /home/team/shared/leads-chicago.csv. Idempotent: safe to
 * re-run — rows are keyed on the natural dedupe (company_name + zip) and
 * skipped when already present, never duplicated. Every imported row is
 * scored with the deterministic rule-based scorer in src/lib/scoring.ts
 * (lead_score + score_tier written at import time).
 *
 * Note: the store also auto-seeds itself on first load, so this script is
 * only needed to (re)import a different CSV or after wiping data/leads.json.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { importCsvIntoStore } from "../src/lib/store.ts";

const DEFAULT_CSV = "/home/team/shared/leads-chicago.csv";

const args = process.argv.slice(2);
let csvPath = DEFAULT_CSV;
const fileFlag = args.indexOf("--file");
if (fileFlag !== -1 && args[fileFlag + 1]) csvPath = resolve(args[fileFlag + 1]);

if (!existsSync(csvPath)) {
  console.error(`CSV file not found: ${csvPath}`);
  process.exit(1);
}

const result = importCsvIntoStore(csvPath);
if (result.csvPath === null) {
  console.error(`Could not import: ${csvPath}`);
  process.exit(1);
}
console.log(`Imported from ${result.csvPath}.`);
console.log(
  `Store now holds ${result.total} leads (${result.inserted} inserted, ${result.skipped} already present — safe to re-run).`,
);
