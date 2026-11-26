import { createFileRoute } from "@tanstack/react-router";
import { requireAuth } from "~/lib/auth";
import { errorResponse, serializeLead } from "~/lib/leads";
import { generateOutreach } from "~/lib/outreach";
import { getLead } from "~/lib/store";

/**
 * Per-lead outreach drafts (server-side only — no email is ever sent).
 * Backed by the $0 file-based JSON store (src/lib/store.ts).
 *
 *   GET /api/outreach?id=123
 *
 * Loads the lead from the local store and returns three personalized drafts
 * (initial email, follow-up email, call script) for agency staff to review
 * and send manually.
 */
export const Route = createFileRoute("/api/outreach")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        // Internal tooling: signed-in team only (401 otherwise).
        const denied = requireAuth(request);
        if (denied) return denied;
        try {
          const url = new URL(request.url);
          const rawId =
            url.searchParams.get("id") ?? url.searchParams.get("lead_id");
          const id = Number(rawId);
          if (!rawId || !Number.isInteger(id) || id <= 0) {
            return Response.json(
              { error: "Missing lead id — pass ?id=<id>" },
              { status: 400 },
            );
          }
          const record = getLead(id);
          if (!record) {
            return Response.json(
              { error: "Lead not found" },
              { status: 404 },
            );
          }
          const lead = serializeLead(
            record as unknown as Record<string, unknown>,
          );
          const str = (v: unknown): string | null =>
            typeof v === "string" ? v : null;
          const drafts = generateOutreach({
            company_name: str(lead.company_name),
            lead_type: str(lead.lead_type),
            city: str(lead.city),
            contact_name: str(lead.contact_name),
            contact_role: str(lead.contact_role),
          });
          return Response.json({ lead_id: id, drafts });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },
  },
});
