import { useMemo, useRef, useState } from "react";
import {
  IMPORT_COLUMNS,
  leadKey,
  parseCsvText,
  rowToLeadBody,
} from "~/lib/csv-import";
import type { ParsedCsvRow } from "~/lib/csv-import";

/**
 * "Import CSV" panel on /leads.
 *
 * Paste sheet text or pick a .csv file → parsed in the browser (src/lib/
 * csv-import.ts, no new dependencies) → previewed → each row POSTed one at a
 * time to the EXISTING POST /api/leads, which validates and scores it
 * server-side exactly like the public homepage form. Nothing is automated,
 * emailed or bulk-sent: this is data entry with a per-row report.
 *
 * Rows whose company name + city already exist in the list are skipped
 * (client-side check — the public endpoint's contract is untouched).
 */

type RowOutcome =
  | { kind: "added"; line: number; company: string; id: number; score: number | null; tier: string | null }
  | { kind: "skipped"; line: number; company: string; reason: string }
  | { kind: "failed"; line: number; company: string; reason: string };

interface PlanItem {
  row: ParsedCsvRow;
  duplicateReason: string | null;
  missingCompany: boolean;
}

const textareaClass =
  "w-full rounded-lg border border-emerald-200 bg-emerald-50/40 px-3 py-2 font-mono text-sm text-gray-800 placeholder:text-gray-400 focus:border-emerald-400 focus:outline-none";

export function CsvImportPanel({
  existingKeys,
  onImported,
  onCancel,
}: {
  /** company_name|city keys already in the store (normalised, see leadKey). */
  existingKeys: Set<string>;
  onImported: (summary: {
    added: number;
    skipped: number;
    failed: number;
  }) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [outcomes, setOutcomes] = useState<RowOutcome[] | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const parsed = useMemo(() => (text.trim() === "" ? null : parseCsvText(text)), [text]);

  const plan = useMemo<PlanItem[]>(() => {
    if (!parsed || parsed.error) return [];
    const inFile = new Map<string, number>();
    return parsed.rows.map((row) => {
      const company = row.values.company_name;
      if (company === "") {
        return { row, duplicateReason: null, missingCompany: true };
      }
      const key = leadKey(company, row.values.city);
      if (existingKeys.has(key))
        return {
          row,
          duplicateReason: "already in the lead list (same company name and city)",
          missingCompany: false,
        };
      const earlier = inFile.get(key);
      if (earlier !== undefined)
        return {
          row,
          duplicateReason: `duplicate of row ${String(earlier)} in this file`,
          missingCompany: false,
        };
      inFile.set(key, row.line);
      return { row, duplicateReason: null, missingCompany: false };
    });
  }, [parsed, existingKeys]);

  const readyCount = plan.filter(
    (p) => p.duplicateReason === null && !p.missingCompany,
  ).length;
  const dupeCount = plan.filter((p) => p.duplicateReason !== null).length;

  async function onPickFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setOutcomes(null);
    setRunError(null);
    try {
      const content = await file.text();
      setText(content);
      setFileName(file.name);
    } catch {
      setRunError("Could not read that file — try pasting the rows instead.");
    }
  }

  async function runImport() {
    if (plan.length === 0) return;
    setRunError(null);
    setOutcomes(null);
    setProgress({ done: 0, total: plan.length });
    const results: RowOutcome[] = [];
    let index = 0;
    for (const item of plan) {
      index += 1;
      const company = item.row.values.company_name;
      const label = company === "" ? "(no company name)" : company;

      if (item.duplicateReason !== null) {
        results.push({
          kind: "skipped",
          line: item.row.line,
          company: label,
          reason: item.duplicateReason,
        });
      } else {
        try {
          const res = await fetch("/api/leads", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(rowToLeadBody(item.row.values)),
          });
          const body = (await res.json().catch(() => null)) as {
            lead?: { id: number; lead_score: number | null; score_tier: string | null };
            error?: string;
          } | null;
          if (!res.ok || !body?.lead) {
            results.push({
              kind: "failed",
              line: item.row.line,
              company: label,
              reason: body?.error ?? `could not be added (HTTP ${String(res.status)})`,
            });
          } else {
            results.push({
              kind: "added",
              line: item.row.line,
              company: label,
              id: body.lead.id,
              score: body.lead.lead_score,
              tier: body.lead.score_tier,
            });
          }
        } catch {
          results.push({
            kind: "failed",
            line: item.row.line,
            company: label,
            reason: "network error — could not reach the server",
          });
        }
      }
      setProgress({ done: index, total: plan.length });
      setOutcomes([...results]);
    }

    setProgress(null);
    const added = results.filter((r) => r.kind === "added").length;
    const skipped = results.filter((r) => r.kind === "skipped").length;
    const failed = results.filter((r) => r.kind === "failed").length;
    await onImported({ added, skipped, failed });
  }

  const summary = useMemo(() => {
    if (!outcomes) return null;
    const added = outcomes.filter((o) => o.kind === "added").length;
    const skipped = outcomes.filter((o) => o.kind === "skipped").length;
    const failed = outcomes.filter((o) => o.kind === "failed").length;
    const parts = [`${String(added)} added`, `${String(skipped)} skipped`];
    if (failed > 0) parts.push(`${String(failed)} failed`);
    const firstProblem = outcomes.find(
      (o): o is Extract<RowOutcome, { kind: "skipped" | "failed" }> =>
        o.kind !== "added",
    );
    return {
      counts: parts.join(", "),
      headline: firstProblem
        ? ` — row ${String(firstProblem.line)}: ${firstProblem.reason}`
        : "",
      added,
      skipped,
      failed,
    };
  }, [outcomes]);

  return (
    <section className="mt-4 rounded-xl border border-emerald-200 bg-[#EFF3F8] p-4 shadow-sm sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-emerald-950">
            Import a CSV list
          </h2>
          <p className="mt-1 text-sm text-gray-600">
            Paste rows from a spreadsheet or choose a .csv file, check the
            preview, then add them. Rows already in the list (same company name
            and city) are skipped, not duplicated.
          </p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          disabled={progress !== null}
          className="shrink-0 rounded-lg border border-emerald-200 bg-emerald-50/40 px-3 py-2 text-sm font-medium text-emerald-800 hover:bg-emerald-50 disabled:opacity-50"
        >
          Close
        </button>
      </div>

      <p className="mt-3 break-words rounded-lg bg-emerald-50/60 px-3 py-2 font-mono text-[11px] leading-relaxed text-gray-600 sm:text-xs">
        Columns: {IMPORT_COLUMNS.join(", ")}
        <span className="mt-1 block font-sans text-xs text-gray-500">
          First line = column names. Other columns are ignored.
        </span>
      </p>

      <div className="mt-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500">
            Paste CSV text
          </span>
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setFileName(null);
              setOutcomes(null);
            }}
            rows={5}
            spellCheck={false}
            placeholder={"company_name,city,state,phone\nHarmony Healthcare,Chicago,IL,773-588-9500"}
            className={textareaClass}
            aria-label="Paste CSV text"
          />
        </label>
      </div>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          ref={fileInput}
          type="file"
          accept=".csv,text/csv"
          onChange={onPickFile}
          className="block w-full text-sm text-gray-700 file:mr-3 file:min-h-[44px] file:rounded-lg file:border file:border-emerald-200 file:bg-emerald-50/60 file:px-4 file:py-2 file:text-sm file:font-medium file:text-emerald-800 hover:file:bg-emerald-50 sm:w-auto sm:text-xs"
          aria-label="Choose a .csv file"
        />
        {text !== "" ? (
          <button
            type="button"
            onClick={() => {
              setText("");
              setFileName(null);
              setOutcomes(null);
              if (fileInput.current) fileInput.current.value = "";
            }}
            className="min-h-[44px] rounded-lg border border-emerald-200 bg-emerald-50/40 px-4 py-2 text-sm font-medium text-emerald-800 hover:bg-emerald-50 sm:w-auto"
          >
            Clear
          </button>
        ) : null}
      </div>
      {fileName ? (
        <p className="mt-2 text-xs text-gray-500">Loaded from {fileName}</p>
      ) : null}

      {parsed?.error ? (
        <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
          {parsed.error}
        </p>
      ) : null}
      {parsed?.truncated ? (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800">
          Only the first 500 rows will be imported. Import the rest in a second
          file.
        </p>
      ) : null}

      {plan.length > 0 ? (
        <div className="mt-4">
          <p className="text-sm text-gray-700">
            <span className="font-semibold text-emerald-950">{plan.length}</span>{" "}
            row{plan.length === 1 ? "" : "s"} found ·{" "}
            <span className="font-semibold text-emerald-800">
              {readyCount} ready to add
            </span>
            {dupeCount > 0 ? (
              <>
                {" · "}
                <span className="font-semibold text-amber-800">
                  {dupeCount} duplicate{dupeCount === 1 ? "" : "s"} will be skipped
                </span>
              </>
            ) : null}
          </p>

          <ul className="mt-2 max-h-80 divide-y divide-emerald-100 overflow-y-auto rounded-lg border border-emerald-100 bg-emerald-50/40">
            {plan.map((item) => {
              const company = item.row.values.company_name;
              const bits = [item.row.values.city, item.row.values.lead_type].filter(
                (v) => v !== "",
              );
              const badge = item.missingCompany
                ? { text: "Missing company name", cls: "bg-red-100 text-red-700" }
                : item.duplicateReason !== null
                  ? { text: "Duplicate — skip", cls: "bg-amber-100 text-amber-800" }
                  : { text: "Ready", cls: "bg-emerald-100 text-emerald-800" };
              return (
                <li key={item.row.line} className="px-3 py-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="min-w-0 break-words text-sm font-medium text-emerald-950">
                      <span className="mr-2 text-xs font-normal text-gray-500">
                        Row {item.row.line}
                      </span>
                      {company === "" ? "(no company name)" : company}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${badge.cls}`}
                    >
                      {badge.text}
                    </span>
                  </div>
                  {bits.length > 0 ? (
                    <p className="text-xs text-gray-500">{bits.join(" · ")}</p>
                  ) : null}
                  {item.duplicateReason !== null ? (
                    <p className="text-xs text-amber-800">{item.duplicateReason}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>

          <button
            type="button"
            onClick={() => void runImport()}
            disabled={progress !== null}
            className="mt-3 min-h-[48px] w-full rounded-lg bg-emerald-700 px-5 py-3 text-base font-semibold text-white shadow-sm hover:bg-emerald-800 active:bg-emerald-900 disabled:opacity-50 sm:w-auto"
          >
            {progress
              ? `Importing ${String(progress.done)} of ${String(progress.total)}…`
              : `Add ${String(plan.length)} row${plan.length === 1 ? "" : "s"}`}
          </button>
        </div>
      ) : null}

      {runError ? (
        <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
          {runError}
        </p>
      ) : null}

      {summary ? (
        <div className="mt-4">
          <p
            className={`rounded-lg border px-3 py-2 text-sm font-semibold ${
              summary.failed > 0
                ? "border-amber-200 bg-amber-50 text-amber-900"
                : "border-emerald-200 bg-emerald-100 text-emerald-900"
            }`}
          >
            {summary.counts}
            {summary.headline}
          </p>
          {outcomes && outcomes.some((o) => o.kind !== "added") ? (
            <ul className="mt-2 space-y-1 text-sm">
              {outcomes
                .filter((o) => o.kind !== "added")
                .map((o) => (
                  <li key={`${o.kind}-${String(o.line)}`} className="text-gray-700">
                    <span className="font-medium">Row {o.line}</span>
                    {" — "}
                    {o.company === "(no company name)" ? "" : `${o.company}: `}
                    {o.kind === "skipped" ? "skipped — " : "not added — "}
                    {o.reason}
                  </li>
                ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
