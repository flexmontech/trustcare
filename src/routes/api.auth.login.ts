import { createFileRoute } from "@tanstack/react-router";
import {
  LOCKOUT_MESSAGE,
  clearFailedAttempts,
  clientIp,
  isPasswordSet,
  jsonResponse,
  lockoutMinutes,
  recordFailedAttempt,
  sessionCookieValue,
  verifyPassword,
} from "~/lib/auth";

/**
 * POST /api/auth/login  { password }
 *
 * The whole sign-in surface: one shared team password, no username. A correct
 * password sets a signed HttpOnly cookie valid for 30 days; a wrong one is
 * counted against the caller's IP (5 tries → 10 minute pause).
 */
export const Route = createFileRoute("/api/auth/login")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isPasswordSet())
          return jsonResponse(
            {
              error:
                "No team password has been set yet. Please set one to continue.",
              needs_setup: true,
            },
            409,
          );

        const ip = clientIp(request);
        if (lockoutMinutes(ip) > 0)
          return jsonResponse({ error: LOCKOUT_MESSAGE }, 429);

        let body: Record<string, unknown> = {};
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          return jsonResponse({ error: "Please enter the team password." }, 400);
        }

        const password = typeof body.password === "string" ? body.password : "";
        if (password.length === 0)
          return jsonResponse({ error: "Please enter the team password." }, 400);

        if (verifyPassword(password)) {
          clearFailedAttempts(ip);
          return jsonResponse(
            { ok: true, redirect_to: "/leads" },
            200,
            sessionCookieValue(request),
          );
        }

        const lockedFor = recordFailedAttempt(ip);
        if (lockedFor > 0)
          return jsonResponse({ error: LOCKOUT_MESSAGE }, 429);

        // Deliberately vague-and-plain: never hint at how close they were.
        return jsonResponse(
          { error: "That password isn't right. Please try again." },
          401,
        );
      },
    },
  },
});
