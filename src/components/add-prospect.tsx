import { useState } from "react";

/**
 * "Add prospect" panel on /leads — a small, phone-friendly form for typing a
 * facility prospect straight into the pipeline.
 *
 * It POSTs to the EXISTING POST /api/leads (src/routes/api.leads.ts), unchanged:
 * that endpoint stays anonymous because the public homepage enquiry form uses
 * it. The panel only renders inside the password-guarded /leads page, so the
 * team sees it and the public never does; the endpoint itself keeps its
 * contract, its validation, and its server-side scoring.
 */

export interface CreatedLeadSummary {
  id: number;
  company_name: string | null;
  lead_score: number | null;
  score_tier: string | null;
}

interface FieldDef {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  autoComplete?: string;
  inputMode?: "text" | "tel" | "email" | "url" | "numeric";
  full?: boolean;
}

const FIELDS: FieldDef[] = [
  {
    name: "company_name",
    label: "Company name",
    required: true,
    placeholder: "e.g. Harmony Healthcare & Rehabilitation Center",
    autoComplete: "organization",
    full: true,
  },
  {
    name: "address",
    label: "Address",
    placeholder: "3919 W Foster Ave",
    autoComplete: "street-address",
    full: true,
  },
  { name: "city", label: "City", placeholder: "Chicago", autoComplete: "address-level2" },
  { name: "state", label: "State", placeholder: "IL", autoComplete: "address-level1" },
  { name: "zip", label: "ZIP", placeholder: "60625", autoComplete: "postal-code", inputMode: "numeric" },
  {
    name: "website",
    label: "Website",
    type: "url",
    placeholder: "https://example.com",
    inputMode: "url",
    autoComplete: "url",
  },
  { name: "contact_name", label: "Contact name", placeholder: "Optional", autoComplete: "name" },
  { name: "contact_role", label: "Contact role", placeholder: "e.g. Director of Nursing" },
  {
    name: "email",
    label: "Email",
    type: "email",
    placeholder: "Optional",
    inputMode: "email",
    autoComplete: "email",
  },
  { name: "phone", label: "Phone", type: "tel", placeholder: "773-588-9500", inputMode: "tel", autoComplete: "tel" },
];

const inputClass =
  "w-full min-h-[44px] rounded-lg border border-emerald-200 bg-emerald-50/40 px-3 py-2 text-base text-gray-800 placeholder:text-gray-400 focus:border-emerald-400 focus:outline-none";

export function AddProspectPanel({
  leadTypes,
  onCreated,
  onCancel,
}: {
  leadTypes: string[];
  onCreated: (lead: CreatedLeadSummary) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (name: string, value: string) =>
    setForm((f) => ({ ...f, [name]: value }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const company = (form.company_name ?? "").trim();
    if (company === "") {
      setError("Company name is required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // Same public endpoint the homepage form uses — body = lead fields only.
      const payload: Record<string, string> = { company_name: company };
      for (const f of [...FIELDS, { name: "lead_type" } as FieldDef]) {
        if (f.name === "company_name") continue;
        const v = (form[f.name] ?? "").trim();
        if (v !== "") payload[f.name] = v;
      }
      const res = await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await res.json().catch(() => null)) as
        | { lead?: CreatedLeadSummary; error?: string; detail?: string }
        | null;
      if (!res.ok || !body?.lead)
        throw new Error(body?.error ?? "Could not add the prospect");
      onCreated(body.lead);
      setForm({});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add the prospect");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="mt-4 rounded-xl border border-emerald-200 bg-[#EFF3F8] p-4 shadow-sm sm:p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-emerald-950">
            Add a prospect
          </h2>
          <p className="mt-1 text-sm text-gray-600">
            Type a facility or home-care organization into the pipeline. Only the
            company name is required — the score is worked out automatically.
          </p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="shrink-0 rounded-lg border border-emerald-200 bg-emerald-50/40 px-3 py-2 text-sm font-medium text-emerald-800 hover:bg-emerald-50"
        >
          Close
        </button>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {FIELDS.map((f) => (
          <label
            key={f.name}
            className={`block ${f.full ? "sm:col-span-2 lg:col-span-2" : ""}`}
          >
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500">
              {f.label}
              {f.required ? (
                <span className="ml-1 text-red-600" aria-hidden="true">
                  *
                </span>
              ) : null}
            </span>
            <input
              name={f.name}
              type={f.type ?? "text"}
              inputMode={f.inputMode}
              autoComplete={f.autoComplete}
              required={f.required}
              value={form[f.name] ?? ""}
              onChange={(e) => set(f.name, e.target.value)}
              placeholder={f.placeholder}
              className={inputClass}
              aria-required={f.required || undefined}
            />
          </label>
        ))}
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500">
            Facility type
          </span>
          <input
            name="lead_type"
            list="lead-type-options"
            value={form.lead_type ?? ""}
            onChange={(e) => set("lead_type", e.target.value)}
            placeholder="e.g. Skilled Nursing / Rehab"
            className={inputClass}
          />
          <datalist id="lead-type-options">
            {leadTypes.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </label>
      </div>

      {error ? (
        <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
          {error}
        </p>
      ) : null}

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <button
          type="submit"
          disabled={submitting}
          className="min-h-[48px] w-full rounded-lg bg-emerald-700 px-5 py-3 text-base font-semibold text-white shadow-sm hover:bg-emerald-800 active:bg-emerald-900 disabled:opacity-50 sm:w-auto"
        >
          {submitting ? "Adding…" : "Add prospect"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="min-h-[44px] w-full rounded-lg border border-emerald-200 bg-emerald-50/40 px-4 py-2 text-sm font-medium text-emerald-800 hover:bg-emerald-50 sm:w-auto"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
