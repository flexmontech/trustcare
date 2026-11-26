import { useEffect, useRef, useState } from "react";

/**
 * One-tap copy for staff working the lead list on a phone.
 *
 * Selecting a long email body by hand on a phone is close to impossible, so
 * every block of text that gets pasted into Gmail (or read out on a call) has
 * its own Copy button. Two strategies, in order:
 *
 *   1. `navigator.clipboard.writeText` — needs a secure context (https) and a
 *      user gesture. This is the normal path on the live site.
 *   2. A hidden, read-only textarea + `document.execCommand("copy")` — the
 *      fallback for older browsers / non-secure contexts. Deprecated but still
 *      the only option there.
 *
 * If BOTH fail we return false and the button says so — never a silent no-op.
 */
export async function copyText(text: string): Promise<boolean> {
  if (text === "") return false;

  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied / insecure context / no focus — fall through.
  }

  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.setAttribute("aria-hidden", "true");
    area.style.position = "fixed";
    area.style.top = "0";
    area.style.left = "-9999px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, area.value.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

type CopyState = "idle" | "copied" | "failed";

/**
 * A 44px-tall copy button. Label flips to "Copied ✓" for ~1.6s, or to a short
 * "Select & copy by hand" instruction if the browser refused the copy.
 */
export function CopyButton({
  text,
  label = "Copy",
  className = "",
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  async function handleClick() {
    const ok = await copyText(text);
    setState(ok ? "copied" : "failed");
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(
      () => setState("idle"),
      ok ? 1600 : 5000,
    );
  }

  const tone =
    state === "copied"
      ? "border-emerald-400 bg-emerald-100 text-emerald-900"
      : state === "failed"
        ? "border-red-300 bg-red-50 text-red-700"
        : "border-emerald-200 bg-[#EFF3F8] text-emerald-800 hover:bg-emerald-50 active:bg-emerald-100";

  return (
    <span className={`inline-flex flex-col items-stretch ${className}`}>
      <button
        type="button"
        onClick={() => void handleClick()}
        aria-label={`${label} — ${state === "copied" ? "copied" : "copy to clipboard"}`}
        className={`min-h-[44px] whitespace-nowrap rounded-lg border px-3 py-2 text-sm font-semibold shadow-sm ${tone}`}
      >
        {state === "copied"
          ? "Copied ✓"
          : state === "failed"
            ? "Copy failed"
            : label}
      </button>
      <span aria-live="polite" className="sr-only">
        {state === "copied" ? "Copied to clipboard" : ""}
      </span>
      {state === "failed" ? (
        <span className="mt-1 max-w-[22rem] text-xs text-red-700">
          This browser blocked copying — press and hold the text and copy it by
          hand.
        </span>
      ) : null}
    </span>
  );
}
