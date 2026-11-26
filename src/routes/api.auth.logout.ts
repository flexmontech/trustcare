import { createFileRoute } from "@tanstack/react-router";
import {
  clearedSessionCookieValue,
  clientIp,
  clearFailedAttempts,
  jsonResponse,
} from "~/lib/auth";

/**
 * POST /api/auth/logout — clears the sign-on cookie. No body needed.
 */
export const Route = createFileRoute("/api/auth/logout")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        clearFailedAttempts(clientIp(request));
        return jsonResponse(
          { ok: true, redirect_to: "/login" },
          200,
          clearedSessionCookieValue(request),
        );
      },
    },
  },
});
