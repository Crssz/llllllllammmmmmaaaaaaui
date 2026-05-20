import { useState } from "react";
import { I } from "../icons";
import { useAppState } from "../state";

const FALLBACK_BINARIES = [
  { name: "llama-server", desc: "HTTP/WebSocket server" },
  { name: "llama-cli", desc: "Interactive REPL" },
  { name: "llama-bench", desc: "Throughput benchmark" },
  { name: "llama-quantize", desc: "Convert / quantize GGUFs" },
  { name: "llama-perplexity", desc: "Eval perplexity" },
  { name: "llama-embedding", desc: "Embedding endpoint" },
];

export function BinaryLocator() {
  const { settings, build, scanning, scanError, pickBuildDir, setBuildDir, rescan, clearRecent } =
    useAppState();
  const [showRecent, setShowRecent] = useState(false);

  const path = build?.path ?? settings.build_dir ?? "";
  const binaries = build?.binaries ?? [];
  const okCount = binaries.filter((b) => b.ok).length;
  const totalCount = binaries.length || FALLBACK_BINARIES.length;
  const detected = !!build?.detected;
  const empty = !settings.build_dir;

  const copyPath = () => {
    if (build?.resolved_path) navigator.clipboard?.writeText(build.resolved_path);
  };

  return (
    <div className="cfg-section binary-section">
      <div className="cfg-section-head" style={{ cursor: "default" }}>
        <I.Terminal size={14} />
        <span>llama.cpp build</span>
        {empty ? (
          <span className="badge ghost" style={{ marginLeft: 6 }}>
            not selected
          </span>
        ) : detected ? (
          <span className="badge green" style={{ marginLeft: 6 }}>
            <span className="dot" />
            detected · {okCount}/{totalCount}
          </span>
        ) : (
          <span className="badge red" style={{ marginLeft: 6 }}>
            <span className="dot" />
            not found
          </span>
        )}
        {build?.version && (
          <span className="sec-count">
            {build.version}
            {build.commit ? ` · ${build.commit}` : ""}
            {build.backend_badges.length ? ` · ${build.backend_badges[0]}` : ""}
          </span>
        )}
      </div>

      <div className="binary-body">
        <div className="bin-path">
          <I.Folder size={14} />
          <span className="mono path-text" title={path || "No directory selected"}>
            {path || "(no directory selected — click Browse…)"}
          </span>
          <div className="bin-path-actions">
            <div style={{ position: "relative" }}>
              <button
                className="btn"
                onClick={() => setShowRecent((s) => !s)}
                title="Recent locations"
                disabled={settings.recent_dirs.length === 0}
              >
                <I.History size={12} /> Recent
              </button>
              {showRecent && settings.recent_dirs.length > 0 && (
                <div className="recent-pop">
                  {settings.recent_dirs.map((p) => (
                    <button
                      key={p}
                      className="recent-item mono"
                      onClick={() => {
                        setShowRecent(false);
                        setBuildDir(p).catch(() => {});
                      }}
                    >
                      <I.Folder size={11} /> {p}
                      {p === path && (
                        <I.Check size={11} style={{ marginLeft: "auto", color: "var(--accent)" }} />
                      )}
                    </button>
                  ))}
                  <div className="recent-sep" />
                  <button
                    className="recent-item"
                    style={{ color: "var(--muted)" }}
                    onClick={() => {
                      setShowRecent(false);
                      clearRecent().catch(() => {});
                    }}
                  >
                    <I.X size={11} /> Clear history
                  </button>
                </div>
              )}
            </div>
            <button
              className="btn primary"
              title="Open OS folder picker"
              onClick={() => pickBuildDir().catch(() => {})}
            >
              <I.Folder size={12} /> Browse…
            </button>
            <button
              className="btn ghost"
              onClick={() => rescan().catch(() => {})}
              title="Re-scan the directory"
              disabled={!settings.build_dir || scanning}
            >
              <I.Refresh
                size={12}
                style={{ animation: scanning ? "spin 0.9s linear infinite" : "none" }}
              />
            </button>
          </div>
        </div>

        {scanError && (
          <div className="badge red" style={{ alignSelf: "flex-start", fontSize: 11 }}>
            scan failed: {scanError}
          </div>
        )}

        <div className="bin-meta">
          <div className="bin-meta-cell">
            <div className="bin-meta-lbl">version</div>
            <div className="bin-meta-val mono">{build?.version ?? "—"}</div>
          </div>
          <div className="bin-meta-cell">
            <div className="bin-meta-lbl">commit</div>
            <div className="bin-meta-val mono">{build?.commit ?? "—"}</div>
          </div>
          <div className="bin-meta-cell">
            <div className="bin-meta-lbl">resolved</div>
            <div
              className="bin-meta-val mono"
              style={{
                fontSize: 11,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
              title={build?.resolved_path ?? ""}
            >
              {build?.resolved_path ? shortenPath(build.resolved_path) : "—"}
            </div>
          </div>
          <div className="bin-meta-cell">
            <div className="bin-meta-lbl">backend</div>
            <div className="bin-meta-val" style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {build?.backend_badges.length ? (
                build.backend_badges.map((b) => (
                  <span key={b} className="badge ghost mono" style={{ fontSize: 10 }}>
                    {b}
                  </span>
                ))
              ) : (
                <span className="badge ghost mono" style={{ fontSize: 10 }}>
                  —
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="bin-list">
          {(binaries.length
            ? binaries
            : FALLBACK_BINARIES.map((b) => ({
                ...b,
                size: "—",
                ok: false,
                primary: b.name === "llama-server",
                path: "",
              }))
          ).map((b) => (
            <div
              key={b.name}
              className={"bin-row" + (b.primary ? " primary" : "") + (b.ok ? "" : " missing")}
            >
              <div className="bin-row-icon">
                {b.ok ? (
                  b.primary ? (
                    <I.Bolt size={13} />
                  ) : (
                    <I.Check size={12} />
                  )
                ) : (
                  <I.X size={12} />
                )}
              </div>
              <div className="bin-row-main">
                <div className="bin-row-name mono">
                  {b.name}
                  {b.primary && b.ok && (
                    <span className="badge accent" style={{ marginLeft: 6, fontSize: 9.5 }}>
                      active
                    </span>
                  )}
                </div>
                <div className="bin-row-desc">{b.desc}</div>
              </div>
              <div className="bin-row-size mono">{b.size}</div>
              <button className="iconbtn" title={b.ok ? "Open" : "Build it"}>
                {b.ok ? <I.Play size={12} /> : <I.Refresh size={12} />}
              </button>
            </div>
          ))}
        </div>

        <div className="bin-footer">
          <span>
            <I.Info size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
            {build?.detected ? (
              <>
                Helm executes{" "}
                <span className="mono" style={{ color: "var(--text-2)" }}>
                  {build.resolved_path}
                  {pathSep(build.resolved_path)}llama-server
                </span>{" "}
                with the flags below.
              </>
            ) : (
              <>Pick a directory to enable Reload model.</>
            )}
          </span>
          <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <button className="btn ghost" onClick={copyPath} disabled={!build?.resolved_path}>
              <I.Copy size={11} /> Copy path
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

function pathSep(p: string): string {
  return p.includes("\\") ? "\\" : "/";
}

function shortenPath(p: string, max = 40): string {
  if (p.length <= max) return p;
  return "…" + p.slice(-(max - 1));
}
