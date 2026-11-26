import { createFileRoute } from "@tanstack/react-router";
import {
  checkPasswordShape,
  clearFailedAttempts,
  clientIp,
  isPasswordSet,
  jsonResponse,
  sessionCookieValue,
  setInitialPassword,
} from "~/lib/auth";

/**
 * POST /api/auth/setup  { password, confirm_password }
 *
 * First run only. Works exactly once: the moment a password exists this route
 * refuses, so it can never be used to overwrite the owner's password. There is
 * no default, seeded or hardcoded password anywhere — the owner chooses it on
 * first open, and only the scrypt hash + salt are stored.
 */
export const Route = createFileRoute("/api/auth/setup")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (isPasswordSet())
          return jsonResponse(
            {
              error:
                "A team password has already been set. Please sign in instead.",
              already_set: true,
            },
            409,
          );

        let body: Record<string, unknown> = {};
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          return jsonResponse({ error: "Please fill in both boxes." }, 400);
        }

        const password = typeof body.password === "string" ? body.password : "";
        const confirm =
          typeof body.confirm_password === "string"
            ? body.confirm_password
            : "";

        const shapeError = checkPasswordShape(password);
        if (shapeError) return jsonResponse({ error: shapeError }, 400);
        if (password !== confirm)
          return jsonResponse(
            { error: "The two passwords don't match. Please type them again." },
            400,
          );

        // setInitialPassword re-checks for an existing password before writing.
        if (!setInitialPassword(password))
          return jsonResponse(
            {
              error:
                "A team password has already been set. Please sign in instead.",
              already_set: true,
            },
            409,
          );

        clearFailedAttempts(clientIp(request));
        // Sign the owner straight in — one less step for a non-technical user.
        return jsonResponse(
          { ok: true },
          200,
          sessionCookieValue(request),
        );
      },
    },
  },
});
