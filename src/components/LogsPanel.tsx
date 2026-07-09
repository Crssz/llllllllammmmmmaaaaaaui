import { useEffect, useMemo, useRef, useState } from "react";
import { I } from "../icons";
import { log, type LogEntry, type LogLevel } from "../lib/logger";

const LEVEL_BADGE: Record<LogLevel, string> = {
  debug: "badge ghost",
  info: "badge accent",
  warn: "badge yellow",
  error: "badge red",
};

const LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

export function LogsPanel({ open, onClose }: Readonly<{ open: boolean; onClose: () => void }>) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [minLevel, setMinLevel] = useState<LogLevel>("debug");
  const [filter, setFilter] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => log.subscribe(setEntries), []);

  const rank = (l: LogLevel) => ({ debug: 0, info: 1, warn: 2, error: 3 })[l];
  const filtered = useMemo(() => {
    const needle = filter.toLowerCase();
    return entries.filter(
      (e) =>
        rank(e.level) >= rank(minLevel) &&
        (!needle ||
          e.message.toLowerCase().includes(needle) ||
          e.area.toLowerCase().includes(needle)),
    );
  }, [entries, minLevel, filter]);

  useEffect(() => {
    if (!open || !autoScroll) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [filtered.length, open, autoScroll]);

  const errorCount = entries.filter((e) => e.level === "error").length;
  const warnCount = entries.filter((e) => e.level === "warn").length;

  if (!open) return null;

  return (
    <div
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: 30, // sit just above statusbar
        height: 280,
        background: "var(--bg-elev)",
        borderTop: "1px solid var(--accent-line)",
        boxShadow: "0 -8px 20px rgba(0,0,0,0.35)",
        zIndex: 50,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 12px",
          borderBottom: "1px solid var(--border)",
          fontSize: 12,
        }}
      >
        <I.Terminal size={13} />
        <span style={{ fontWeight: 600 }}>Logs</span>
        <span className="badge ghost mono">{entries.length} entries</span>
        {errorCount > 0 && (
          <span className="badge red mono">
            {errorCount} error{errorCount === 1 ? "" : "s"}
          </span>
        )}
        {warnCount > 0 && <span className="badge yellow mono">{warnCount} warn</span>}

        <div className="segmented" style={{ marginLeft: 8 }}>
          {LEVELS.map((l) => (
            <button
              key={l}
              className={minLevel === l ? "on" : ""}
              onClick={() => setMinLevel(l)}
              title={`Show ${l} and above`}
            >
              {l}
            </button>
          ))}
        </div>

        <input
          className="input mono"
          placeholder="Filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ width: 160, fontSize: 11.5 }}
        />

        <span style={{ flex: 1 }} />

        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            fontSize: 11.5,
            color: "var(--muted)",
            cursor: "pointer",
            userSelect: "none",
          }}
        >
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
          />{" "}
          auto-scroll
        </label>
        <button className="btn ghost" onClick={() => log.clear()} title="Clear logs">
          <I.X size={11} /> Clear
        </button>
        <button className="btn ghost" onClick={onClose} title="Close panel">
          <I.Chevron size={12} style={{ transform: "rotate(180deg)" }} />
        </button>
      </div>

      <div
        ref={bodyRef}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "6px 12px",
          fontFamily: "var(--font-mono)",
          fontSize: 11.5,
          lineHeight: 1.55,
        }}
      >
        {filtered.length === 0 ? (
          <div
            style={{
              padding: 24,
              textAlign: "center",
              color: "var(--muted)",
              fontFamily: "var(--font-ui)",
              fontSize: 12.5,
            }}
          >
            No log entries match the current filter.
          </div>
        ) : (
          filtered.map((e) => {
            const d = new Date(e.time);
            const ts =
              d.toTimeString().slice(0, 8) + "." + String(d.getMilliseconds()).padStart(3, "0");
            return (
              <div
                key={e.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "92px 50px 90px 1fr",
                  gap: 8,
                  padding: "2px 0",
                  borderBottom: "1px solid var(--border)",
                  color: "var(--text-2)",
                  alignItems: "baseline",
                }}
              >
                <span style={{ color: "var(--subtle)" }}>{ts}</span>
                <span
                  className={LEVEL_BADGE[e.level]}
                  style={{ fontSize: 11, padding: "1px 5px" }}
                >
                  {e.level}
                </span>
                <span style={{ color: "var(--muted)" }}>[{e.area}]</span>
                <span style={{ wordBreak: "break-word", color: "var(--text)" }}>
                  {e.message}
                  {e.meta !== undefined && (
                    <span
                      style={{
                        marginLeft: 8,
                        color: "var(--subtle)",
                        fontSize: 11,
                      }}
                    >
                      {safeStringify(e.meta)}
                    </span>
                  )}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function safeStringify(v: unknown): string {
  try {
    if (typeof v === "string") return v;
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
