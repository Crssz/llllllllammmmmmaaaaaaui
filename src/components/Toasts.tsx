import { useEffect, useState } from "react";
import { log, type Toast } from "../lib/logger";

const DISMISS_MS = 6000;

type SetToasts = React.Dispatch<React.SetStateAction<Toast[]>>;

// Module-level helper so the dismissal closures don't nest past the function
// depth limit inside the component's effect.
function scheduleDismiss(setToasts: SetToasts, id: number) {
  globalThis.setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), DISMISS_MS);
}

function ToastCard({ toast: t, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        background:
          t.level === "error"
            ? "var(--red-bg, #2a1414)"
            : t.level === "info"
              ? "var(--green-bg, #142a1c)"
              : "var(--surface, #2a2418)",
        border: `1px solid ${
          t.level === "error"
            ? "var(--red, #e57792)"
            : t.level === "info"
              ? "var(--green, #6fcf97)"
              : "var(--yellow, #e7b15b)"
        }`,
        color: "var(--text, #e6e6e6)",
        padding: "10px 12px",
        borderRadius: 6,
        fontSize: 12.5,
        lineHeight: 1.45,
        boxShadow: "0 6px 18px rgba(0,0,0,0.4)",
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 2 }}>
          {t.level.toUpperCase()} · {t.area}
        </div>
        <div>{t.message}</div>
      </div>
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(t.id)}
        style={{
          flexShrink: 0,
          font: "inherit",
          fontSize: 14,
          appearance: "none",
          background: "transparent",
          border: "none",
          color: "inherit",
          opacity: 0.7,
          lineHeight: 1,
          padding: 0,
          cursor: "pointer",
        }}
      >
        ×
      </button>
    </div>
  );
}

export function Toasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    const onToast = (t: Toast) => {
      setToasts((prev) => [...prev, t]);
      // Errors stay until dismissed by hand — a screen-reader user needs
      // time to reach and read one before it would otherwise vanish.
      if (t.level !== "error") scheduleDismiss(setToasts, t.id);
    };
    return log.subscribeToasts(onToast);
  }, []);

  const dismiss = (id: number) => setToasts((prev) => prev.filter((x) => x.id !== id));
  const errorToasts = toasts.filter((t) => t.level === "error");
  const otherToasts = toasts.filter((t) => t.level !== "error");

  return (
    <div
      style={{
        position: "fixed",
        bottom: 18,
        right: 18,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        zIndex: 9999,
        maxWidth: 360,
      }}
    >
      {/* Both regions stay mounted even when empty: a live region has to
          already exist in the DOM before its content changes, or assistive
          tech never picks up the announcement. Errors get their own
          assertive region so they interrupt; everything else is polite. */}
      <div role="alert" aria-live="assertive" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {errorToasts.map((t) => (
          <ToastCard key={t.id} toast={t} onDismiss={dismiss} />
        ))}
      </div>
      <div role="status" aria-live="polite" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {otherToasts.map((t) => (
          <ToastCard key={t.id} toast={t} onDismiss={dismiss} />
        ))}
      </div>
    </div>
  );
}
