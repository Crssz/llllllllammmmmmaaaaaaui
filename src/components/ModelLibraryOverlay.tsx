import { useEffect, useMemo, useRef, useState } from "react";
import { I } from "../icons";
import { useAppStore } from "../state";
import { useShallow } from "zustand/react/shallow";
import { api, type GgufInfo, type HipfireLocalModel } from "../lib/api";
import { ExpandedRow, bitsClass, flatten, type FlatRow } from "../screens/Models";
import { useContextMenu, type MenuItem } from "./ContextMenu";
import { quantDescription } from "../lib/quant";

type SortBy = "recent" | "size" | "name";

function basename(p: string): string {
  if (!p) return "";
  const sep = p.includes("\\") ? "\\" : "/";
  return p.split(sep).pop() || p;
}

// hipfire's `size` is already a formatted string (e.g. "15.0GB") — parse the
// leading number for the "size" sort, same idea as llama's quant.size_gb.
function parseSizeGb(size: string): number {
  return parseFloat(size) || 0;
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
    reloadServer,
    modelInfo,
    setEngineKind,
    setHipfireFlag,
    hipfireModelsVersion,
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
      reloadServer: s.reloadServer,
      modelInfo: s.modelInfo,
      setEngineKind: s.setEngineKind,
      setHipfireFlag: s.setHipfireFlag,
      // Bumped store-side after a successful pull elsewhere (e.g. Configure's
      // HipfirePullPanel) — re-fetching on it means a model pulled while this
      // overlay isn't even open shows up without a manual refresh click.
      hipfireModelsVersion: s.hipfirePull.modelsVersion,
    })),
  );

  const isHipfire = settings.engine_kind === "hipfire";

  const panelRef = useRef<HTMLDivElement | null>(null);
  const openMenu = useContextMenu();
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortBy>("recent");
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [rowInfo, setRowInfo] = useState<Record<string, GgufInfo | "loading" | "error">>({});

  // Local hipfire model list — parallel to Configure's HipfireModelPicker,
  // but this overlay is the ONLY place a hipfire user picks a model to serve
  // (Configure's picker feeds the same hipfire_flags.tag field, just from a
  // different screen), so it owns its own fetch rather than sharing state.
  const [hipfireModels, setHipfireModels] = useState<HipfireLocalModel[]>([]);
  const [hipfireModelsError, setHipfireModelsError] = useState<string | null>(null);
  const [hipfireModelsLoading, setHipfireModelsLoading] = useState(false);

  const refreshHipfireModels = async () => {
    setHipfireModelsLoading(true);
    setHipfireModelsError(null);
    try {
      const list = await api.listHipfireModels(settings.hipfire_path);
      setHipfireModels(list);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setHipfireModels([]);
      // hipfire not installed (or otherwise unreachable) surfaces here as a
      // small inline error below — never a crash.
      setHipfireModelsError(msg);
    } finally {
      setHipfireModelsLoading(false);
    }
  };

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

  useEffect(() => {
    if (!open || !isHipfire) return;
    // Mirrors the expandedKey reset effect above — fetching on open/engine-
    // switch/refresh is the point of this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refreshHipfireModels().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isHipfire, settings.hipfire_path, hipfireModelsVersion]);

  // Click outside / Esc closes
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      // Ignore clicks inside a context menu spawned from this overlay — the
      // menu is rendered at the app root, outside panelRef. (`Element`, not
      // `HTMLElement`: the click target may be an SVG icon inside the menu.)
      if (e.target instanceof Element && e.target.closest(".ctx-menu")) return;
      if (panelRef.current && e.target instanceof Node && !panelRef.current.contains(e.target)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      // While a context menu is open, Escape should close only the menu.
      if (e.key === "Escape" && !document.querySelector(".ctx-menu")) onClose();
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

  const hipfireRows: HipfireLocalModel[] = useMemo(() => {
    let list = hipfireModels;
    if (q) {
      const needle = q.toLowerCase();
      list = list.filter(
        (m) => m.tag.toLowerCase().includes(needle) || m.file.toLowerCase().includes(needle),
      );
    }
    if (sort === "size") {
      list = [...list].sort((a, b) => parseSizeGb(b.size) - parseSizeGb(a.size));
    } else if (sort === "name") {
      list = [...list].sort((a, b) => a.tag.localeCompare(b.tag));
    }
    return list;
  }, [hipfireModels, q, sort]);

  if (!open) return null;

  // Loaded/selected identity — llama keys off the GGUF path (flags.model);
  // hipfire has no --model flag and no /props endpoint (fact 5), so its
  // identity is the configured tag instead.
  const loadedKey = isHipfire
    ? String((settings.hipfire_flags as Record<string, unknown>)?.tag ?? "")
    : (flags.model as string) || "";
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
    // Switch to the picked model and restart the server so it's live
    // immediately — stops a running server first, then starts with the new
    // model (or just starts it if it was stopped).
    reloadServer().catch(() => {});
  };

  // hipfire equivalent of doLoad: writes hipfire_flags.tag (the same update
  // path Configure's HipfireModelPicker uses) instead of flags.model, then
  // reloads exactly like the llama pick does.
  const doLoadHipfire = (tag: string, andClose = true) => {
    setHipfireFlag("tag", tag);
    if (andClose) onClose();
    reloadServer().catch(() => {});
  };

  const rowMenuItems = (r: FlatRow, isLoaded: boolean): MenuItem[] => [
    {
      label: "Load & restart server",
      icon: "Play",
      disabled: isLoaded,
      onClick: () => doLoad(r.quant.path, true),
    },
    {
      label: "Set as model (no restart)",
      icon: "Check",
      disabled: isLoaded,
      onClick: () => loadModelPath(r.quant.path),
    },
    {
      label: expandedKey === r.quant.path ? "Collapse details" : "Configure / details",
      icon: "Sliders",
      onClick: () => toggleRow(r.quant.path, r.quant.path),
    },
    "separator",
    {
      label: "Reveal in Explorer",
      icon: "Folder",
      onClick: () => api.revealInExplorer(r.quant.path).catch(() => {}),
    },
    {
      label: "Copy path",
      icon: "Copy",
      onClick: () => navigator.clipboard?.writeText(r.quant.path).catch(() => {}),
    },
  ];

  const rowCount = isHipfire ? hipfireRows.length : rows.length;

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
                {isHipfire ? loadedKey : basename(loadedKey)}
              </div>
            ) : (
              <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
                {isHipfire
                  ? "Pick a local hipfire tag below, or pull one on Configure."
                  : "Pick a GGUF below or browse to one on disk."}
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
                {/* modelInfo is GGUF/--props-derived — llama only (fact 5).
                    It's cleared whenever hipfire is active (see effects.tsx),
                    but guard on isHipfire directly here too so these badges
                    can never render stale llama data for a hipfire tag. */}
                {!isHipfire && modelInfo?.architecture && (
                  <span className="badge ghost mono" style={{ fontSize: 10 }}>
                    {modelInfo.architecture}
                  </span>
                )}
                {!isHipfire && modelInfo?.mtp_support && (
                  <span className="badge accent" style={{ fontSize: 10 }}>
                    <I.Spark size={9} /> MTP ✓
                  </span>
                )}
                {!isHipfire && modelInfo?.size_gb && (
                  <span className="badge ghost mono" style={{ fontSize: 10 }}>
                    {modelInfo.size_gb.toFixed(1)} GB
                  </span>
                )}
                {isHipfire && loadedKey.endsWith("-draft") && (
                  <span className="badge ghost" style={{ fontSize: 10 }}>
                    draft companion
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

          {/* Engine switch — wired to the same settings.engine_kind setter
              Configure uses. Switching here only changes the next-launch
              target, exactly like Configure's toggle; it does not restart a
              running server on its own. */}
          <span
            className="segmented"
            title="Inference engine — switching does not restart the server"
            style={{ flexShrink: 0 }}
          >
            <button className={isHipfire ? "" : "on"} onClick={() => setEngineKind("llama")}>
              llama.cpp
            </button>
            <button className={isHipfire ? "on" : ""} onClick={() => setEngineKind("hipfire")}>
              hipfire
            </button>
          </span>

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
              placeholder={
                isHipfire
                  ? "Filter by tag or file…"
                  : "Filter by owner, model, quant, or filename…"
              }
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <span className="badge ghost mono">
            {rowCount} {rowCount === 1 ? "row" : "rows"}
          </span>
          <span
            className="badge ghost mono"
            style={{ color: "var(--muted)" }}
            title={isHipfire ? settings.hipfire_path || "auto (PATH)" : (settings.models_dir ?? "")}
          >
            {isHipfire
              ? settings.hipfire_path
                ? basename(settings.hipfire_path)
                : "auto (PATH)"
              : settings.models_dir
                ? basename(settings.models_dir)
                : "no directory"}
          </span>
          <span style={{ flex: 1 }} />
          {isHipfire && (
            <button
              className="btn ghost"
              onClick={() => refreshHipfireModels().catch(() => {})}
              title="Refresh local model list"
              disabled={hipfireModelsLoading}
            >
              <I.Refresh
                size={11}
                style={{ animation: hipfireModelsLoading ? "spin 0.9s linear infinite" : "none" }}
              />
            </button>
          )}
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
          {isHipfire ? (
            hipfireModelsError ? (
              <div
                style={{
                  padding: "24px",
                  textAlign: "center",
                  color: "var(--red)",
                  fontSize: 12.5,
                }}
              >
                Couldn&apos;t list local hipfire models: {hipfireModelsError}
              </div>
            ) : hipfireRows.length === 0 ? (
              <div
                style={{
                  padding: "40px 24px",
                  textAlign: "center",
                  color: "var(--muted)",
                  fontSize: 13,
                }}
              >
                {hipfireModelsLoading
                  ? "Scanning…"
                  : hipfireModels.length === 0
                    ? "No local hipfire models yet — pull one from HuggingFace or convert a GGUF on Configure."
                    : "No models match your filter."}
              </div>
            ) : (
              <div className="model-table" style={{ border: 0, borderRadius: 0 }}>
                {hipfireRows.map((m) => {
                  const isLoaded = m.tag === loadedKey;
                  const isDraft = m.tag.endsWith("-draft");
                  return (
                    <div
                      key={m.tag}
                      className={"model-row" + (isLoaded ? " loaded-row" : "")}
                      style={{ gridTemplateColumns: "minmax(160px, 1fr) minmax(160px, 1.6fr) 90px auto" }}
                    >
                      <div className="model-row-name">
                        <span className="quant-tag mono">{m.tag}</span>
                        {isDraft && (
                          <span
                            className="badge ghost"
                            style={{ fontSize: 9.5, padding: "1px 5px" }}
                            title="Speculative-decoding draft — pairs with its target model"
                          >
                            draft companion
                          </span>
                        )}
                        {isLoaded &&
                          (server.running ? (
                            <span
                              className="badge green"
                              style={{ fontSize: 9.5, padding: "1px 5px" }}
                              title="The server is serving this tag"
                            >
                              <span className="dot" /> loaded
                            </span>
                          ) : (
                            <span
                              className="badge ghost"
                              style={{ fontSize: 9.5, padding: "1px 5px" }}
                              title="Set as the tag to serve — start the server to load it"
                            >
                              selected
                            </span>
                          ))}
                      </div>
                      <div className="model-row-owner" title={m.file}>
                        {m.file}
                      </div>
                      <div className="model-row-cell mono" style={{ textAlign: "right" }}>
                        {m.size}
                      </div>
                      <button
                        className="btn"
                        style={{ padding: "3px 9px" }}
                        onClick={() => doLoadHipfire(m.tag, true)}
                        disabled={isLoaded}
                        title={isLoaded ? "Already selected" : "Serve this tag & restart the server"}
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
                    </div>
                  );
                })}
              </div>
            )
          ) : rows.length === 0 ? (
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
                  : (models?.count ?? 0) === 0
                    ? "No .gguf files found under <owner>/<model>/."
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
                      onContextMenu={(e) => openMenu(e, rowMenuItems(r, isLoaded))}
                    >
                      <div className="model-row-name">
                        <span
                          className={"quant-tag mono " + bitsClass(r.quant.bits)}
                          title={quantDescription(r.quant.tag)}
                        >
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
                        {isLoaded &&
                          (server.running ? (
                            <span
                              className="badge green"
                              style={{ fontSize: 9.5, padding: "1px 5px" }}
                              title="The server is running this model"
                            >
                              <span className="dot" /> loaded
                            </span>
                          ) : (
                            <span
                              className="badge ghost"
                              style={{ fontSize: 9.5, padding: "1px 5px" }}
                              title="Set as --model — start the server to load it"
                            >
                              selected
                            </span>
                          ))}
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
                        onClick={() => doLoad(r.quant.path, true)}
                        disabled={isLoaded}
                        title={isLoaded ? "Already loaded" : "Load this model & restart the server"}
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
                        title={isExpanded ? "Collapse" : "Expand to configure"}
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
          <span>
            {isHipfire
              ? "Load switches the model tag and restarts the server. New tags come from Configure — pull one from HuggingFace or convert a GGUF."
              : "Load switches the model and restarts the server. Use a row's chevron to inspect & quick-config first."}
          </span>
          <span style={{ flex: 1 }} />
          {isHipfire ? (
            <button
              className="btn"
              onClick={() => refreshHipfireModels().catch(() => {})}
              disabled={hipfireModelsLoading}
            >
              <I.Refresh
                size={11}
                style={{ animation: hipfireModelsLoading ? "spin 0.9s linear infinite" : "none" }}
              />{" "}
              Refresh
            </button>
          ) : (
            <>
              <button
                className="btn"
                onClick={() => {
                  // Match row-Load: after a file is chosen, restart the server so it
                  // actually loads (setting --model alone doesn't), then close. On
                  // cancel, keep the overlay open. Start failures surface via toast.
                  pickModel()
                    .then((picked) => {
                      if (!picked) return;
                      onClose();
                      reloadServer().catch(() => {});
                    })
                    .catch(() => {});
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
            </>
          )}
        </div>
      </div>
    </>
  );
}
