import { useEffect, useMemo, useRef, useState } from "react";
import { I } from "../icons";
import { useAppStore } from "../state";
import { useShallow } from "zustand/react/shallow";
import { api, type GgufInfo } from "../lib/api";
import { ExpandedRow, bitsClass, flatten, type FlatRow } from "../screens/Models";

type SortBy = "recent" | "size" | "name";

function basename(p: string): string {
  if (!p) return "";
  const sep = p.includes("\\") ? "\\" : "/";
  return p.split(sep).pop() || p;
}

export function ModelLibraryOverlay({
  open,
  onClose,
  onOpenModelsTab,
}: Readonly<{
  open: boolean;
  onClose: () => void;
  onOpenModelsTab: () => void;
}>) {
  const {
    flags,
    setFlag,
    settings,
    models,
    modelsScanning,
    pickModelsDir,
    pickModel,
    loadModelPath,
    server,
    stopServer,
    modelInfo,
  } = useAppStore(
    useShallow((s) => ({
      flags: s.flags,
      setFlag: s.setFlag,
      settings: s.settings,
      models: s.models,
      modelsScanning: s.modelsScanning,
      pickModelsDir: s.pickModelsDir,
      pickModel: s.pickModel,
      loadModelPath: s.loadModelPath,
      server: s.server,
      stopServer: s.stopServer,
      modelInfo: s.modelInfo,
    })),
  );

  const panelRef = useRef<HTMLDivElement | null>(null);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortBy>("recent");
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [rowInfo, setRowInfo] = useState<Record<string, GgufInfo | "loading" | "error">>({});

  // Reset transient state each time the popover opens. We accept the
  // cascading-render warning because the alternative — deriving
  // expandedKey from `open` — would tangle "user-selected" with
  // "auto-reset" semantics.
  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setExpandedKey(null);
    }
  }, [open]);

  // Click outside / Esc closes
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (panelRef.current && e.target instanceof Node && !panelRef.current.contains(e.target)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    globalThis.addEventListener("mousedown", onDocMouseDown);
    globalThis.addEventListener("keydown", onKey);
    return () => {
      globalThis.removeEventListener("mousedown", onDocMouseDown);
      globalThis.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  const rows: FlatRow[] = useMemo(() => {
    let flat = flatten(models?.tree ?? []);
    if (q) {
      const needle = q.toLowerCase();
      flat = flat.filter(
        (r) =>
          `${r.owner}/${r.model.name}`.toLowerCase().includes(needle) ||
          r.quant.tag.toLowerCase().includes(needle) ||
          r.quant.filename.toLowerCase().includes(needle),
      );
    }
    if (sort === "size") {
      flat.sort((a, b) => b.quant.size_gb - a.quant.size_gb);
    } else if (sort === "name") {
      flat.sort((a, b) =>
        `${a.owner}/${a.model.name}-${a.quant.tag}`.localeCompare(
          `${b.owner}/${b.model.name}-${b.quant.tag}`,
        ),
      );
    }
    return flat;
  }, [models, q, sort]);

  if (!open) return null;

  const loadedKey = (flags.model as string) || "";
  const ensureRowInfo = (key: string, p: string) => {
    if (rowInfo[key]) return;
    setRowInfo((prev) => ({ ...prev, [key]: "loading" }));
    api
      .inspectGguf(p)
      .then((info) => setRowInfo((prev) => ({ ...prev, [key]: info })))
      .catch(() => setRowInfo((prev) => ({ ...prev, [key]: "error" })));
  };

  const toggleRow = (key: string, p: string) => {
    setExpandedKey((cur) => {
      const next = cur === key ? null : key;
      if (next === key) ensureRowInfo(key, p);
      return next;
    });
  };

  const doLoad = (p: string, andClose = true) => {
    loadModelPath(p);
    if (andClose) onClose();
    if (server.running) {
      // Safer default: stop so the next Start picks up the new model.
      stopServer().catch(() => {});
    }
  };

  return (
    <>
      {/* dim backdrop */}
      <div
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.35)",
          backdropFilter: "blur(2px)",
          zIndex: 70,
        }}
      />
      <div
        ref={panelRef}
        style={{
          position: "fixed",
          top: 50,
          left: 16,
          right: 16,
          bottom: 40,
          background: "var(--bg-elev)",
          border: "1px solid var(--border-strong)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-pop)",
          zIndex: 71,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Loaded header */}
        <div
          style={{
            padding: "14px 18px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            gap: 14,
            alignItems: "center",
            background: "linear-gradient(180deg, var(--surface), var(--bg-elev))",
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 10.5,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                color: "var(--subtle)",
                fontWeight: 600,
              }}
            >
              {loadedKey
                ? server.running
                  ? "Currently loaded · running"
                  : "Currently loaded · stopped"
                : "No model loaded"}
            </div>
            {loadedKey ? (
              <div
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 13,
                  color: "var(--text)",
                  marginTop: 2,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
                title={loadedKey}
              >
                {basename(loadedKey)}
              </div>
            ) : (
              <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
                Pick a GGUF below or browse to one on disk.
              </div>
            )}
            {loadedKey && (
              <div
                style={{
                  fontSize: 11,
                  color: "var(--muted)",
                  marginTop: 4,
                  display: "flex",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                {modelInfo?.architecture && (
                  <span className="badge ghost mono" style={{ fontSize: 10 }}>
                    {modelInfo.architecture}
                  </span>
                )}
                {modelInfo?.mtp_support && (
                  <span className="badge accent" style={{ fontSize: 10 }}>
                    <I.Spark size={9} /> MTP ✓
                  </span>
                )}
                {modelInfo?.size_gb && (
                  <span className="badge ghost mono" style={{ fontSize: 10 }}>
                    {modelInfo.size_gb.toFixed(1)} GB
                  </span>
                )}
                {server.running && server.info && (
                  <span className="badge green" style={{ fontSize: 10 }}>
                    pid {server.info.pid} · :{server.info.port}
                  </span>
                )}
              </div>
            )}
          </div>

          {server.running ? (
            <button
              className="btn"
              style={{ color: "var(--red)" }}
              onClick={() => {
                stopServer().catch(() => {});
              }}
            >
              <I.Stop size={11} /> Stop server
            </button>
          ) : null}

          <button
            className="btn ghost"
            onClick={onClose}
            title="Close (Esc)"
            style={{ marginLeft: 2 }}
          >
            <I.X size={12} />
          </button>
        </div>

        {/* Library toolbar */}
        <div
          style={{
            padding: "10px 18px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            gap: 10,
            alignItems: "center",
          }}
        >
          <div style={{ flex: 1, maxWidth: 460 }} className="prof-search">
            <I.Search />
            <input
              autoFocus
              placeholder="Filter by owner, model, quant, or filename…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <span className="badge ghost mono">
            {rows.length} {rows.length === 1 ? "row" : "rows"}
          </span>
          <span
            className="badge ghost mono"
            style={{ color: "var(--muted)" }}
            title={settings.models_dir ?? ""}
          >
            {settings.models_dir ? basename(settings.models_dir) : "no directory"}
          </span>
          <span style={{ flex: 1 }} />
          <div className="segmented">
            {(["recent", "size", "name"] as SortBy[]).map((s) => (
              <button key={s} className={sort === s ? "on" : ""} onClick={() => setSort(s)}>
                {s}
              </button>
            ))}
          </div>
        </div>

        {/* Table body */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            background: "var(--bg)",
          }}
        >
          {rows.length === 0 ? (
            <div
              style={{
                padding: "40px 24px",
                textAlign: "center",
                color: "var(--muted)",
                fontSize: 13,
              }}
            >
              {!settings.models_dir
                ? "Pick a models directory below."
                : modelsScanning
                  ? "Scanning…"
                  : "No models match your filter."}
            </div>
          ) : (
            <div className="model-table" style={{ border: 0, borderRadius: 0 }}>
              {rows.map((r) => {
                const key = r.quant.path;
                const isLoaded = key === loadedKey;
                const isExpanded = expandedKey === key;
                const info = rowInfo[key];
                const archLabel =
                  info && info !== "loading" && info !== "error"
                    ? (info.architecture ?? "?")
                    : (r.model.family ?? "GGUF");
                return (
                  <div key={key}>
                    <div
                      className={
                        "model-row" +
                        (isLoaded ? " loaded-row" : "") +
                        (isExpanded ? " active" : "")
                      }
                    >
                      <div className="model-row-name">
                        <span className={"quant-tag mono " + bitsClass(r.quant.bits)}>
                          {r.quant.tag}
                        </span>
                        <span className="mname" title={r.quant.filename}>
                          {r.model.name}
                        </span>
                        {r.model.mtp && (
                          <span
                            className="badge accent"
                            style={{ fontSize: 9.5, padding: "1px 5px" }}
                          >
                            MTP
                          </span>
                        )}
                        {r.model.mmproj_files.length > 0 && (
                          <span
                            className="badge ghost"
                            style={{
                              fontSize: 9.5,
                              padding: "1px 5px",
                              color: "var(--cyan)",
                              borderColor: "oklch(0.55 0.11 210 / 0.45)",
                            }}
                            title="Vision-capable — mmproj will auto-load"
                          >
                            VL
                          </span>
                        )}
                        {isLoaded && (
                          <span
                            className="badge green"
                            style={{ fontSize: 9.5, padding: "1px 5px" }}
                          >
                            <span className="dot" /> loaded
                          </span>
                        )}
                      </div>
                      <div className="model-row-owner" title={r.owner}>
                        {r.owner}
                      </div>
                      <div className="model-row-cell mono">{r.model.params ?? "—"}</div>
                      <div
                        className="model-row-cell mono"
                        style={{ color: "var(--muted)" }}
                        title={archLabel}
                      >
                        {archLabel}
                      </div>
                      <div className="model-row-cell">
                        <span className="badge ghost" style={{ fontSize: 9.5, padding: "1px 5px" }}>
                          GGUF
                        </span>
                      </div>
                      <div className="model-row-cell mono" style={{ textAlign: "right" }}>
                        {r.quant.size_gb.toFixed(2)} GB
                      </div>
                      <button
                        className="btn"
                        style={{ padding: "3px 9px" }}
                        onClick={(e) => {
                          if (e.altKey) doLoad(r.quant.path, true);
                          else toggleRow(key, r.quant.path);
                        }}
                        disabled={isLoaded}
                        title={
                          isLoaded
                            ? "Already loaded"
                            : "Click to configure · Alt-click to load directly"
                        }
                      >
                        {isLoaded ? (
                          <>
                            <I.Check size={11} /> Loaded
                          </>
                        ) : (
                          <>
                            <I.Play size={11} /> Load
                          </>
                        )}
                      </button>
                      <button
                        className={"chev-toggle" + (isExpanded ? " open" : "")}
                        onClick={() => toggleRow(key, r.quant.path)}
                      >
                        <I.ChevR size={12} />
                      </button>
                    </div>

                    {isExpanded && (
                      <ExpandedRow
                        row={r}
                        info={info}
                        flags={flags as Record<string, string | number | boolean>}
                        setFlag={setFlag}
                        onLoad={() => doLoad(r.quant.path, true)}
                        isLoaded={isLoaded}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "10px 18px",
            borderTop: "1px solid var(--border)",
            display: "flex",
            gap: 10,
            alignItems: "center",
            background: "var(--bg-elev)",
            fontSize: 11.5,
            color: "var(--muted)",
          }}
        >
          <I.Info size={11} />
          <span>Alt-click Load to skip the inline config panel.</span>
          <span style={{ flex: 1 }} />
          <button
            className="btn"
            onClick={() => {
              pickModel().catch(() => {});
              onClose();
            }}
          >
            <I.Folder size={11} /> Browse for GGUF…
          </button>
          <button
            className="btn"
            onClick={() => {
              pickModelsDir().catch(() => {});
            }}
          >
            <I.Folder size={11} /> Change directory…
          </button>
          <button
            className="btn"
            onClick={() => {
              onClose();
              onOpenModelsTab();
            }}
          >
            <I.Sliders size={11} /> Full Models tab
          </button>
        </div>
      </div>
    </>
  );
}
