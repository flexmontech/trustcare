import { createFileRoute } from "@tanstack/react-router";
import { requireAuth } from "~/lib/auth";
import {
  badRequest,
  errorResponse,
  normalizeLeadInput,
  parseLeadId,
  serializeLead,
  updateLead,
} from "~/lib/leads";
import {
  createLead,
  deleteLead,
  getLead,
  listLeads,
} from "~/lib/store";

/**
 * Leads collection endpoint backed by the $0 file-based JSON store
 * (src/lib/store.ts) — no database, no DATABASE_URL, no Neon.
 *
 *   GET    /api/leads?lead_status=New   list (optional status/type/tier/
 *                                        response/due_before filters)
 *   GET filters: lead_status, lead_type, score_tier (HOT/WARM/COLD),
 *     response_classification (Interested / Needs Staffing / Not Interested /
 *     No Response / Do Not Contact), due_before=YYYY-MM-DD (follow-up queue:
 *     next_follow_up_date on or before the date).
 *   POST   /api/leads                   create { company_name, ... }
 *   PATCH  /api/leads?id=123            update (body: any lead fields,
 *     incl. response_classification + follow-up fields). Edits that touch the
 *     cadence (status, response, dates, follow_up_count) recompute
 *     next_follow_up_date via src/lib/followup.ts; terminal responses clear it.
 *   DELETE /api/leads?id=123            delete
 *
 * Contact logging lives in its own endpoint: POST /api/leads/contact?id=123
 * (src/routes/api.leads.contact.ts) — one tap sets the contact date, count,
 * next follow-up date and status together.
 *
 * Individual-record updates/deletes take the id as a query param (`?id=`)
 * rather than a `:id` path segment — the TanStack router generator mangles
 * `$id` dynamic segments in dot-style API filenames, so a query param is the
 * pattern that actually works here.
 *
 * Scores: lead_score + score_tier are computed server-side with
 * src/lib/scoring.ts on every create/update (never client-controlled).
 * Errors are honest JSON (400/404, no stack traces).
 */
export const Route = createFileRoute("/api/leads")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        // Internal data: signed-in team only (401 otherwise, never lead data).
        const denied = requireAuth(request);
        if (denied) return denied;
        try {
          const url = new URL(request.url);
          const pick = (name: string): string | null => {
            const v = url.searchParams.get(name)?.trim();
            return v ? v : null;
          };
          const due_before = pick("due_before");
          if (due_before && !/^\d{4}-\d{2}-\d{2}$/.test(due_before))
            throw badRequest("due_before must be a date in YYYY-MM-DD format");
          const leads = listLeads({
            lead_status: pick("lead_status"),
            lead_type: pick("lead_type"),
            score_tier: pick("score_tier")
              ? pick("score_tier")!.toUpperCase()
              : null,
            response_classification: pick("response_classification"),
            due_before,
          });
          return Response.json({
            leads: leads.map((l) =>
              serializeLead(l as unknown as Record<string, unknown>),
            ),
          });
        } catch (err) {
          return errorResponse(err);
        }
      },

      // Deliberately PUBLIC: the homepage family-enquiry form posts here. It
      // only creates a lead (with validation) and never returns the pipeline.
      POST: async ({ request }) => {
        try {
          let body: Record<string, unknown>;
          try {
            body = (await request.json()) as Record<string, unknown>;
          } catch {
            throw badRequest("Request body must be valid JSON");
          }
          const lead = normalizeLeadInput(body, true);
          const created = createLead(
            lead as unknown as Parameters<typeof createLead>[0],
          );
          return Response.json(
            {
              lead: serializeLead(
                created as unknown as Record<string, unknown>,
              ),
            },
            { status: 201 },
          );
        } catch (err) {
          return errorResponse(err);
        }
      },

      PATCH: async ({ request }) => {
        const denied = requireAuth(request);
        if (denied) return denied;
        try {
          const url = new URL(request.url);
          const rawId =
            url.searchParams.get("id") ?? url.searchParams.get("lead_id");
          if (!rawId) throw badRequest("Missing lead id — pass ?id=<id>");
          const id = parseLeadId(rawId);
          let body: Record<string, unknown>;
          try {
            body = (await request.json()) as Record<string, unknown>;
          } catch {
            throw badRequest("Request body must be valid JSON");
          }
          const updated = updateLead(id, body);
          return Response.json({ lead: updated });
        } catch (err) {
          return errorResponse(err);
        }
      },

      DELETE: async ({ request }) => {
        const denied = requireAuth(request);
        if (denied) return denied;
        try {
          const url = new URL(request.url);
          const rawId =
            url.searchParams.get("id") ?? url.searchParams.get("lead_id");
          if (!rawId) throw badRequest("Missing lead id — pass ?id=<id>");
          const id = parseLeadId(rawId);
          const existing = getLead(id);
          if (!existing)
            return Response.json({ error: "Lead not found" }, { status: 404 });
          deleteLead(id);
          return Response.json({ deleted: true, id });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },
  },
});
