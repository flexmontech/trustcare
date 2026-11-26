import { createFileRoute } from "@tanstack/react-router";
import { requireAuth } from "~/lib/auth";
import { badRequest, errorResponse, logContact, parseLeadId } from "~/lib/leads";

/**
 * Contact logging — the action agency staff use most.
 *
 *   POST /api/leads/contact?id=123
 *   body: { "channel": "Phone call" | "Email" | "In person / other",
 *           "note": "optional short note" }
 *
 * One call does everything (see planContactLog in src/lib/followup.ts):
 *   last_contact_date = today, follow_up_count +1, next_follow_up_date set from
 *   the Day 0/3/7/14 cadence anchored on the first contact, lead_status =
 *   Contacted, and the note appended to the lead's notes. Terminal responses
 *   (Not Interested / Do Not Contact) schedule no further date.
 *
 * Internal tooling: signed-in team only (401 otherwise). This endpoint is
 * deliberately NOT public — only POST /api/leads (the homepage enquiry form)
 * stays open to anonymous visitors.
 */
export const Route = createFileRoute("/api/leads/contact")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const denied = requireAuth(request);
        if (denied) return denied;
        try {
          const url = new URL(request.url);
          const rawId =
            url.searchParams.get("id") ?? url.searchParams.get("lead_id");
          if (!rawId) throw badRequest("Missing lead id — pass ?id=<id>");
          const id = parseLeadId(rawId);
          let body: unknown;
          try {
            body = await request.json();
          } catch {
            throw badRequest("Request body must be valid JSON");
          }
          if (typeof body !== "object" || body === null || Array.isArray(body))
            throw badRequest("Request body must be a JSON object");
          const result = logContact(id, body as Record<string, unknown>);
          return Response.json(result);
        } catch (err) {
          return errorResponse(err);
        }
      },
    },
  },
});
