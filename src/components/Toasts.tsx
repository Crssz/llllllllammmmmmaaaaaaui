import { useEffect, useState } from "react";
import { log, type Toast } from "../lib/logger";

const DISMISS_MS = 6000;

export function Toasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    const unsub = log.subscribeToasts((t) => {
      setToasts((prev) => [...prev, t]);
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((x) => x.id !== t.id));
      }, DISMISS_MS);
    });
    return unsub;
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
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
      {toasts.map((t) => (
        <div
          key={t.id}
          style={{
            background: t.level === "error" ? "var(--red, #2a1414)" : "var(--surface, #2a2418)",
            border: `1px solid ${t.level === "error" ? "var(--red-edge, #e57792)" : "var(--yellow, #e7b15b)"}`,
            color: "var(--text, #e6e6e6)",
            padding: "10px 12px",
            borderRadius: 6,
            fontSize: 12.5,
            lineHeight: 1.45,
            boxShadow: "0 6px 18px rgba(0,0,0,0.4)",
            cursor: "pointer",
          }}
          role="button"
          tabIndex={0}
          aria-label="Dismiss notification"
          onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setToasts((prev) => prev.filter((x) => x.id !== t.id));
            }
          }}
        >
          <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 2 }}>
            {t.level.toUpperCase()} · {t.area}
          </div>
          <div>{t.message}</div>
        </div>
      ))}
    </div>
  );
}
