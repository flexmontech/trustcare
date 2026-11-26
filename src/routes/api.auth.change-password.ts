import { createFileRoute } from "@tanstack/react-router";
import {
  LOCKOUT_MESSAGE,
  changePassword,
  checkPasswordShape,
  clearFailedAttempts,
  clientIp,
  jsonResponse,
  lockoutMinutes,
  recordFailedAttempt,
  requireAuth,
  sessionCookieValue,
  verifyPassword,
} from "~/lib/auth";

/**
 * POST /api/auth/change-password
 *   { current_password, new_password, confirm_password }
 *
 * Signed-in only. The current password must be typed again (so a borrowed
 * unlocked phone can't quietly change the team password), and the caller gets
 * a fresh 30-day cookie because changing the password signs out every other
 * device.
 */
export const Route = createFileRoute("/api/auth/change-password")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const denied = requireAuth(request);
        if (denied) return denied;

        const ip = clientIp(request);
        if (lockoutMinutes(ip) > 0)
          return jsonResponse({ error: LOCKOUT_MESSAGE }, 429);

        let body: Record<string, unknown> = {};
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          return jsonResponse(
            { error: "Please fill in all three boxes." },
            400,
          );
        }

        const current =
          typeof body.current_password === "string"
            ? body.current_password
            : "";
        const next =
          typeof body.new_password === "string" ? body.new_password : "";
        const confirm =
          typeof body.confirm_password === "string"
            ? body.confirm_password
            : "";

        if (current.length === 0)
          return jsonResponse(
            { error: "Please type the current team password." },
            400,
          );

        if (!verifyPassword(current)) {
          const lockedFor = recordFailedAttempt(ip);
          if (lockedFor > 0)
            return jsonResponse({ error: LOCKOUT_MESSAGE }, 429);
          return jsonResponse(
            { error: "That current password isn't right. Please try again." },
            401,
          );
        }

        const shapeError = checkPasswordShape(next);
        if (shapeError) return jsonResponse({ error: shapeError }, 400);
        if (next !== confirm)
          return jsonResponse(
            {
              error:
                "The two new passwords don't match. Please type them again.",
            },
            400,
          );
        if (next === current)
          return jsonResponse(
            { error: "The new password should be different from the old one." },
            400,
          );

        if (!changePassword(current, next))
          return jsonResponse(
            { error: "Could not change the password. Please try again." },
            500,
          );

        clearFailedAttempts(ip);
        // New cookie: changing the password invalidates every older session.
        return jsonResponse(
          { ok: true },
          200,
          sessionCookieValue(request),
        );
      },
    },
  },
});
