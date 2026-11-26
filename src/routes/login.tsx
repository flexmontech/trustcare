import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { isAuthenticatedRequest, isPasswordSet } from "~/lib/auth";

/**
 * /login — Trust Care team workspace sign-on.
 *
 * Deliberately the simplest possible thing: one password box and one big
 * button. No username, no email, no "forgot password", no technical words.
 * On the very first visit (before the owner has chosen a password) the same
 * page shows a one-time "set the team password" form instead, and that path
 * closes permanently once a password exists.
 */

const getSignOnState = createServerFn({ method: "GET" }).handler(async () => {
  const { getRequest } = await import("@tanstack/react-start/server");
  const request = getRequest();
  return {
    passwordSet: isPasswordSet(),
    signedIn: isAuthenticatedRequest(request),
  };
});

/** Only allow in-site paths as a post-sign-in destination. */
function safeNext(raw: unknown): string {
  if (typeof raw !== "string") return "/leads";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/leads";
  if (raw.startsWith("/login")) return "/leads";
  return raw;
}

export const Route = createFileRoute("/login")({
  head: () => ({ meta: [{ title: "Trust Care Agency — team sign-on" }] }),
  validateSearch: (
    search: Record<string, unknown>,
  ): { next?: string } => ({
    next: typeof search.next === "string" ? search.next : undefined,
  }),
  loader: async () => {
    const state = await getSignOnState();
    if (state.signedIn) throw redirect({ to: "/leads" });
    return state;
  },
  component: LoginPage,
});

function LoginPage() {
  const { passwordSet } = Route.useLoaderData();
  const search = Route.useSearch();
  const [mode, setMode] = useState<"login" | "setup">(
    passwordSet ? "login" : "setup",
  );
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isSetup = mode === "setup";

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const typed = password.trim().length > 0 ? password : "";
    if (typed.length === 0) {
      setError("Please enter the team password.");
      return;
    }
    if (isSetup && typed !== confirm) {
      setError("The two passwords don't match. Please type them again.");
      return;
    }

    setBusy(true);
    try {
      const res = await fetch(
        isSetup ? "/api/auth/setup" : "/api/auth/login",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            isSetup
              ? { password: typed, confirm_password: confirm }
              : { password: typed },
          ),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        needs_setup?: boolean;
        already_set?: boolean;
      };

      if (res.ok) {
        // Full page load so the server sees the new cookie straight away.
        window.location.assign(safeNext(search.next));
        return;
      }

      if (data.needs_setup) {
        setMode("setup");
        setError(data.error ?? "Please set the team password to continue.");
        return;
      }
      if (data.already_set) {
        setMode("login");
        setError(data.error ?? "Please sign in instead.");
        return;
      }
      setError(data.error ?? "Something went wrong. Please try again.");
    } catch {
      setError("Couldn't connect. Please check your internet and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-emerald-50 px-5 py-10">
      <div className="w-full max-w-md">
        <div className="flex items-center justify-center gap-2">
          <span
            aria-hidden="true"
            className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-700 text-lg font-bold text-white"
          >
            T
          </span>
          <span className="text-lg font-bold tracking-tight text-emerald-950">
            Trust Care Agency
          </span>
        </div>

        <div className="mt-6 rounded-2xl border border-emerald-200 bg-emerald-50 p-6 shadow-sm sm:p-8">
          <h1 className="text-2xl font-bold tracking-tight text-emerald-950">
            {isSetup ? "Set the team password" : "Welcome back"}
          </h1>
          <p className="mt-2 text-base leading-relaxed text-gray-700">
            {isSetup
              ? "Choose one password for the whole team. You'll only do this once — everyone uses it to open the workspace."
              : "Trust Care team workspace — enter your team password to continue."}
          </p>

          <form onSubmit={(e) => void submit(e)} className="mt-6 space-y-4">
            <label className="block text-sm font-semibold text-emerald-900">
              {isSetup ? "New team password" : "Team password"}
              <input
                type="password"
                name="password"
                autoComplete={isSetup ? "new-password" : "current-password"}
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Type the password"
                className="mt-1 w-full rounded-xl border border-emerald-300 bg-white px-4 py-3.5 text-lg text-emerald-950 shadow-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-200"
              />
            </label>

            {isSetup ? (
              <label className="block text-sm font-semibold text-emerald-900">
                Type it again
                <input
                  type="password"
                  name="confirm"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="Type the password again"
                  className="mt-1 w-full rounded-xl border border-emerald-300 bg-white px-4 py-3.5 text-lg text-emerald-950 shadow-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-200"
                />
              </label>
            ) : null}

            {isSetup ? (
              <p className="text-sm text-gray-600">
                Use at least 8 characters. Small and capital letters, numbers or
                a symbol all help.
              </p>
            ) : null}

            {error ? (
              <p
                role="alert"
                className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700"
              >
                {error}
              </p>
            ) : null}

            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-xl bg-emerald-700 px-4 py-4 text-lg font-semibold text-white shadow-sm transition hover:bg-emerald-800 disabled:opacity-60"
            >
              {busy
                ? "One moment…"
                : isSetup
                  ? "Set password and open workspace"
                  : "Open the workspace"}
            </button>
          </form>
        </div>

        <p className="mt-5 text-center text-sm text-gray-600">
          Everyone on the team uses the same password. You stay signed in on this
          device for 30 days.
        </p>
      </div>
    </main>
  );
}
