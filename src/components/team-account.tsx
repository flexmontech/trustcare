import { useState } from "react";

/**
 * The whole account surface for the team workspace, on internal pages only:
 * a "Log out" button and a small "Change team password" form. One shared
 * password, no usernames, no roles, no user list — deliberately.
 *
 * Both controls talk to the auth API with the signed session cookie that the
 * browser already holds; nothing here is secret-bearing.
 */

const inputClass =
  "mt-1 w-full rounded-lg border border-emerald-200 bg-white px-3 py-2.5 text-base text-emerald-950 shadow-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-200";

export function TeamAccount() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [form, setForm] = useState({
    current_password: "",
    new_password: "",
    confirm_password: "",
  });

  async function logOut() {
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // even if the call fails, sending them to /login is harmless
    } finally {
      window.location.assign("/login");
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setDone(null);
    setBusy(true);
    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!res.ok) {
        setError(data.error ?? "Could not change the password. Please try again.");
        return;
      }
      setForm({ current_password: "", new_password: "", confirm_password: "" });
      setDone("Team password changed.");
      setOpen(false);
    } catch {
      setError("Could not change the password. Please check your connection.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-stretch gap-2 sm:items-end">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => {
            setOpen((v) => !v);
            setError(null);
            setDone(null);
          }}
          className="rounded-lg border border-emerald-200 bg-[#EFF3F8] px-4 py-2 text-sm font-medium text-emerald-800 shadow-sm hover:bg-emerald-50"
        >
          {open ? "Cancel" : "Change team password"}
        </button>
        <button
          type="button"
          onClick={() => void logOut()}
          disabled={busy}
          className="rounded-lg border border-emerald-200 bg-emerald-700 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-800 disabled:opacity-60"
        >
          Log out
        </button>
      </div>

      {done ? (
        <p className="rounded-lg border border-emerald-200 bg-emerald-100 px-3 py-2 text-sm font-medium text-emerald-900">
          ✓ {done}
        </p>
      ) : null}

      {open ? (
        <form
          onSubmit={(e) => void submit(e)}
          className="w-full max-w-sm rounded-xl border border-emerald-200 bg-emerald-50/80 p-4 text-left shadow-sm sm:w-80"
        >
          <p className="text-sm font-semibold text-emerald-950">
            Change the team password
          </p>
          <p className="mt-1 text-xs text-gray-600">
            Everyone shares this one password. Changing it signs out other
            phones and computers.
          </p>

          <label className="mt-3 block text-sm font-medium text-emerald-900">
            Current password
            <input
              type="password"
              autoComplete="current-password"
              value={form.current_password}
              onChange={(e) =>
                setForm((f) => ({ ...f, current_password: e.target.value }))
              }
              className={inputClass}
            />
          </label>
          <label className="mt-3 block text-sm font-medium text-emerald-900">
            New password
            <input
              type="password"
              autoComplete="new-password"
              value={form.new_password}
              onChange={(e) =>
                setForm((f) => ({ ...f, new_password: e.target.value }))
              }
              className={inputClass}
            />
          </label>
          <label className="mt-3 block text-sm font-medium text-emerald-900">
            Type the new password again
            <input
              type="password"
              autoComplete="new-password"
              value={form.confirm_password}
              onChange={(e) =>
                setForm((f) => ({ ...f, confirm_password: e.target.value }))
              }
              className={inputClass}
            />
          </label>

          {error ? (
            <p
              role="alert"
              className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700"
            >
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={busy}
            className="mt-4 w-full rounded-lg bg-emerald-700 px-4 py-3 text-base font-semibold text-white shadow-sm hover:bg-emerald-800 disabled:opacity-60"
          >
            {busy ? "Saving…" : "Save new password"}
          </button>
        </form>
      ) : null}
    </div>
  );
}
