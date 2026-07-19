import { useEffect, useMemo, useState } from "react";
import { I } from "../icons";
import { useAppStore } from "../state";
import { useShallow } from "zustand/react/shallow";
import {
  api,
  type GgufInfo,
  type HipfireLocalModel,
  type ModelEntry,
  type OwnerEntry,
  type QuantFile,
} from "../lib/api";
import { useContextMenu, type MenuItem } from "../components/ContextMenu";
import { useConfirm } from "../components/ConfirmDialog";
import { quantDescription } from "../lib/quant";
import { log } from "../lib/logger";

type SortBy = "recent" | "size" | "name";

// Flatten the owner→model→quant tree into one row per quant for table-style rendering.
export type FlatRow = {
  owner: string;
  model: ModelEntry;
  quant: QuantFile;
};

export function flatten(tree: OwnerEntry[]): FlatRow[] {
  const out: FlatRow[] = [];
  for (const o of tree) {
    for (const m of o.models) {
      for (const q of m.quants) {
        out.push({ owner: o.owner, model: m, quant: q });
      }
    }
  }
  return out;
}

// Mirror of the backend's split-shard grouping ("…-00001-of-00003.gguf"):
// deleting any part deletes the whole group, so the in-use guard must treat
// every sibling of the loaded model as in use too.
export function splitGroupKey(path: string): string {
  const m = /^(.*)-\d{5}-of-(\d{5})\.gguf$/i.exec(path);
  return m ? `${m[1]}-of-${m[2]}` : path;
}

export function bitsClass(bits: number): string {
  // Map bit depth to a colored quant-tag class (already styled in styles.css)
  if (bits <= 3) return "q-bits-3";
  if (bits === 4) return "q-bits-4";
  if (bits === 5) return "q-bits-5";
  if (bits === 6) return "q-bits-6";
  if (bits === 8) return "q-bits-8";
  return "q-bits-16";
}

export function ModelsScreen() {
  const engineKind = useAppStore((s) => s.settings.engine_kind);
  // hipfire's "library" is a flat local tag registry, not a scanned GGUF
  // owner/model/quant tree — render the dedicated panel instead. The llama
  // branch below (and everything it renders) is untouched by this check.
  if (engineKind === "hipfire") return <HipfireModelsPanel />;
  return <LlamaModelsPanel />;
}

function LlamaModelsPanel() {
  const {
    flags,
    settings,
    models,
    modelsScanning,
    modelsScanError,
    pickModelsDir,
    setModelsDir,
    rescanModels,
    clearModelsRecent,
    loadModelPath,
    setFlag,
    reloadServer,
    server,
  } = useAppStore(
    useShallow((s) => ({
      flags: s.flags,
      settings: s.settings,
      models: s.models,
      modelsScanning: s.modelsScanning,
      modelsScanError: s.modelsScanError,
      pickModelsDir: s.pickModelsDir,
      setModelsDir: s.setModelsDir,
      rescanModels: s.rescanModels,
      clearModelsRecent: s.clearModelsRecent,
      loadModelPath: s.loadModelPath,
      setFlag: s.setFlag,
      reloadServer: s.reloadServer,
      server: s.server,
    })),
  );

  const { confirmElement, confirm } = useConfirm();
  const [showRecent, setShowRecent] = useState(false);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortBy>("recent");
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  // Per-row arch / MTP info, fetched lazily when a row is expanded.
  const [rowInfo, setRowInfo] = useState<Record<string, GgufInfo | "loading" | "error">>({});

  const path = settings.models_dir ?? "";
  const totalGB = models?.total_gb ?? 0;
  const count = models?.count ?? 0;
  const ownersN = models?.owners ?? 0;
  const loadedKey = (flags.model as string) || "";

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

  const ensureRowInfo = (key: string, p: string) => {
    if (rowInfo[key]) return; // already cached or in flight
    setRowInfo((prev) => ({ ...prev, [key]: "loading" }));
    api
      .inspectGguf(p)
      .then((info) => setRowInfo((prev) => ({ ...prev, [key]: info })))
      .catch(() => setRowInfo((prev) => ({ ...prev, [key]: "error" })));
  };

  const onToggle = (key: string, p: string) => {
    setExpandedKey((cur) => {
      const next = cur === key ? null : key;
      if (next === key) ensureRowInfo(key, p);
      return next;
    });
  };

  const onLoad = async (p: string) => {
    loadModelPath(p);
    // Switch to this model and restart the server so it's live immediately:
    // stops a running server first, then starts with the new model (or just
    // starts it if it was stopped), using the current flags.
    await reloadServer();
  };

  const openMenu = useContextMenu();

  const onDeleteModel = async (r: FlatRow) => {
    const ok = await confirm({
      title: `Delete "${r.quant.filename}"?`,
      body: "This permanently removes the file from disk and cannot be undone.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      const n = await api.deleteModelFile(r.quant.path);
      log.info("models", `deleted ${n} file${n === 1 ? "" : "s"} for ${r.quant.filename}`);
    } catch (e: unknown) {
      log.notify("error", "models", `Delete failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      // Rescan even on error — a split delete may have removed some parts.
      await rescanModels().catch(() => {});
    }
  };

  const modelMenuItems = (r: FlatRow, isLoaded: boolean): MenuItem[] => {
    // Deleting removes ALL split siblings, so block the delete whenever any
    // model the running server uses (main or speculative drafter) belongs to
    // the same split group — not just on exact path match.
    const inUsePaths = [
      loadedKey,
      flags.model_draft as string,
      flags.model_draft_mtp as string,
      flags.model_draft_dflash as string,
    ].filter(Boolean);
    const rowKey = splitGroupKey(r.quant.path);
    const deleteBlocked = server.running && inUsePaths.some((p) => splitGroupKey(p) === rowKey);
    return [
      {
        label: "Load & restart server",
        icon: "Play",
        disabled: isLoaded,
        onClick: () => onLoad(r.quant.path).catch(() => {}),
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
        onClick: () => onToggle(r.quant.path, r.quant.path),
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
      {
        label: "Copy filename",
        icon: "Copy",
        onClick: () => navigator.clipboard?.writeText(r.quant.filename).catch(() => {}),
      },
      "separator",
      {
        label: "Re-scan library",
        icon: "Refresh",
        disabled: modelsScanning,
        onClick: () => rescanModels().catch(() => {}),
      },
      "separator",
      {
        label: "Delete from disk…",
        icon: "Trash",
        danger: true,
        disabled: deleteBlocked,
        hint: deleteBlocked ? "in use" : undefined,
        onClick: () => {
          onDeleteModel(r).catch(() => {});
        },
      },
    ];
  };

  return (
    <>
      {confirmElement}
      <div className="page-head">
        <div>
          <div className="crumb">Models / library</div>
          <h1>Model library</h1>
        </div>
        <div className="head-meta">
          <span className="badge ghost mono">{count} files</span>
          <span className="badge ghost mono">{totalGB.toFixed(1)} GB</span>
          <button
            className="btn"
            onClick={() => rescanModels().catch(() => {})}
            disabled={!path || modelsScanning}
            title={
              !path
                ? "Pick a models folder first"
                : modelsScanning
                  ? "Scanning…"
                  : "Re-scan the models folder"
            }
          >
            <I.Refresh
              size={12}
              style={{ animation: modelsScanning ? "spin 0.9s linear infinite" : "none" }}
            />{" "}
            Re-scan
          </button>
          <button className="btn primary" onClick={() => pickModelsDir().catch(() => {})}>
            <I.Folder size={12} /> Browse…
          </button>
        </div>
      </div>

      <div className="page-body">
        <div className="cfg-section binary-section" style={{ marginBottom: 18 }}>
          <div className="cfg-section-head" style={{ cursor: "default" }}>
            <I.Folder size={14} />
            <span>Models directory</span>
            {path ? (
              <span className="badge green" style={{ marginLeft: 6 }}>
                <span className="dot" />
                scanned · {count} models · {ownersN} owners
              </span>
            ) : (
              <span className="badge ghost" style={{ marginLeft: 6 }}>
                not selected
              </span>
            )}
            {path && <span className="sec-count">{totalGB.toFixed(1)} GB on disk</span>}
          </div>
          <div className="binary-body">
            <div className="bin-path">
              <I.Folder size={14} />
              <span className="mono path-text" title={path}>
                {path || "(no directory selected — click Browse…)"}
              </span>
              <div className="bin-path-actions">
                <div style={{ position: "relative" }}>
                  <button
                    className="btn"
                    onClick={() => setShowRecent((s) => !s)}
                    disabled={settings.models_recent.length === 0}
                    title={
                      settings.models_recent.length === 0
                        ? "No recent folders yet"
                        : "Recently used models folders"
                    }
                  >
                    <I.History size={12} /> Recent
                  </button>
                  {showRecent && settings.models_recent.length > 0 && (
                    <div className="recent-pop">
                      {settings.models_recent.map((p) => (
                        <button
                          key={p}
                          className="recent-item mono"
                          title={p}
                          onClick={() => {
                            setShowRecent(false);
                            setModelsDir(p).catch(() => {});
                          }}
                        >
                          <I.Folder size={11} /> {p}
                          {p === path && (
                            <I.Check
                              size={11}
                              style={{ marginLeft: "auto", color: "var(--accent)" }}
                            />
                          )}
                        </button>
                      ))}
                      <div className="recent-sep" />
                      <button
                        className="recent-item"
                        style={{ color: "var(--muted)" }}
                        onClick={() => {
                          setShowRecent(false);
                          clearModelsRecent().catch(() => {});
                        }}
                      >
                        <I.X size={11} /> Clear history
                      </button>
                    </div>
                  )}
                </div>
                <button
                  className="btn ghost"
                  onClick={() => rescanModels().catch(() => {})}
                  disabled={!path || modelsScanning}
                  title={
                    !path
                      ? "Pick a models folder first"
                      : modelsScanning
                        ? "Scanning…"
                        : "Re-scan the models folder"
                  }
                >
                  <I.Refresh
                    size={12}
                    style={{
                      animation: modelsScanning ? "spin 0.9s linear infinite" : "none",
                    }}
                  />
                </button>
              </div>
            </div>
            {modelsScanError && (
              <div className="badge red" style={{ alignSelf: "flex-start", fontSize: 11 }}>
                scan failed: {modelsScanError}
              </div>
            )}
            <div className="bin-footer">
              <span>
                <I.Info size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
                The app scans{" "}
                <span className="mono" style={{ color: "var(--text-2)" }}>
                  {path || "<dir>"}/&lt;owner&gt;/&lt;model&gt;/*.gguf
                </span>{" "}
                — click <strong>Load</strong> to switch the model & restart the server, or use a
                row&apos;s chevron to inspect & quick-config first.
              </span>
            </div>
          </div>
        </div>

        <div className="prof-toolbar" style={{ marginBottom: 16 }}>
          <div className="prof-search">
            <I.Search />
            <input
              placeholder="Filter by owner, model, quant, or filename…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <span className="badge ghost mono">
            {rows.length} {rows.length === 1 ? "row" : "rows"}
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

        {rows.length === 0 ? (
          <div
            style={{
              padding: "40px 24px",
              textAlign: "center",
              color: "var(--muted)",
              fontSize: 13,
              border: "1px dashed var(--border)",
              borderRadius: "var(--radius-lg)",
            }}
          >
            {!path
              ? "Pick a models directory to start."
              : modelsScanning
                ? "Scanning…"
                : count === 0
                  ? "No .gguf files found under <owner>/<model>/."
                  : "No models match your filter."}
          </div>
        ) : (
          <div className="model-table">
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
                      "model-row" + (isLoaded ? " loaded-row" : "") + (isExpanded ? " active" : "")
                    }
                    onContextMenu={(e) => openMenu(e, modelMenuItems(r, isLoaded))}
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
                          title="MTP heads"
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
                          title={`Vision-capable — mmproj ready: ${r.model.mmproj_files
                            .map((f) => f.split(/[\\/]/).pop())
                            .join(", ")}`}
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
                      onClick={() => onLoad(r.quant.path).catch(() => {})}
                      title={isLoaded ? "Already loaded" : "Load this model & restart the server"}
                      disabled={isLoaded}
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
                      onClick={() => onToggle(key, r.quant.path)}
                      title={isExpanded ? "Collapse" : "Expand to configure"}
                    >
                      <I.ChevR size={12} />
                    </button>
                  </div>

                  {isExpanded && (
                    <ExpandedRow
                      row={r}
                      info={info}
                      flags={flags}
                      setFlag={setFlag}
                      onLoad={() => onLoad(r.quant.path).catch(() => {})}
                      isLoaded={isLoaded}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

// ── hipfire local registry ──────────────────────────────────────────────────
// hipfire has no scanned GGUF tree — its "library" is the flat set of tags
// `hipfire list` already registers. Rows mirror the llama table's per-row
// actions where they have a hipfire equivalent: "Serve" (writes
// hipfire_flags.tag + reloadServer(), the same flow ModelLibraryOverlay's
// hipfire row uses) and "Delete" (NEW hipfire_rm command, confirmed via
// useConfirm and refused with a toast while the tag is the one actually being
// served).
function HipfireModelsPanel() {
  const { settings, server, loadedEngine, setHipfireFlag, reloadServer, hipfireModelsVersion } =
    useAppStore(
      useShallow((s) => ({
        settings: s.settings,
        server: s.server,
        loadedEngine: s.loadedEngine,
        setHipfireFlag: s.setHipfireFlag,
        reloadServer: s.reloadServer,
        // Bumped store-side after a successful pull (Catalog's hipfire mode /
        // Configure's HipfirePullPanel) — re-fetching on it means a model
        // pulled elsewhere shows up here without a manual refresh click.
        hipfireModelsVersion: s.hipfirePull.modelsVersion,
      })),
    );

  const { confirmElement, confirm } = useConfirm();
  const [models, setModels] = useState<HipfireLocalModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await api.listHipfireModels(settings.hipfire_path);
      setModels(list);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setModels([]);
      setError(msg);
      log.warn("hipfire", "list_hipfire_models failed", { error: msg });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.hipfire_path, hipfireModelsVersion]);

  const hipfireTag = String((settings.hipfire_flags as Record<string, unknown>)?.tag ?? "");

  const rows = useMemo(() => {
    let list = models;
    if (q) {
      const needle = q.toLowerCase();
      list = list.filter(
        (m) => m.tag.toLowerCase().includes(needle) || m.file.toLowerCase().includes(needle),
      );
    }
    return [...list].sort((a, b) => a.tag.localeCompare(b.tag));
  }, [models, q]);

  const doServe = (tag: string) => {
    setHipfireFlag("tag", tag);
    reloadServer().catch(() => {});
  };

  // "Serving" means the running server is actually hipfire serving this exact
  // tag — not merely that this tag is the configured selection (mirrors
  // ModelLibraryOverlay's isServing / Models's isLoaded+server.running check).
  const isServing = (tag: string) =>
    tag === hipfireTag && server.running && loadedEngine === "hipfire";

  const doDelete = async (m: HipfireLocalModel) => {
    if (isServing(m.tag)) {
      log.notify(
        "warn",
        "hipfire",
        `"${m.tag}" is currently being served — stop the server before deleting it.`,
      );
      return;
    }
    const ok = await confirm({
      title: `Delete "${m.tag}"?`,
      body: "This removes the model from hipfire's local store and cannot be undone.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.hipfireRm(m.tag, settings.hipfire_path);
      log.info("hipfire", `deleted ${m.tag}`);
    } catch (e: unknown) {
      log.notify(
        "error",
        "hipfire",
        `Delete failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      await refresh().catch(() => {});
    }
  };

  const rowMenuItems = (m: HipfireLocalModel): MenuItem[] => {
    const serving = isServing(m.tag);
    return [
      {
        label: "Serve",
        icon: "Play",
        disabled: serving,
        onClick: () => doServe(m.tag),
      },
      "separator",
      {
        label: "Copy tag",
        icon: "Copy",
        onClick: () => navigator.clipboard?.writeText(m.tag).catch(() => {}),
      },
      {
        label: "Copy filename",
        icon: "Copy",
        onClick: () => navigator.clipboard?.writeText(m.file).catch(() => {}),
      },
      "separator",
      {
        label: "Re-scan library",
        icon: "Refresh",
        disabled: loading,
        onClick: () => refresh().catch(() => {}),
      },
      "separator",
      {
        label: "Delete from hipfire's store…",
        icon: "Trash",
        danger: true,
        disabled: serving,
        hint: serving ? "in use" : undefined,
        onClick: () => {
          doDelete(m).catch(() => {});
        },
      },
    ];
  };

  const openMenu = useContextMenu();

  return (
    <>
      {confirmElement}
      <div className="page-head">
        <div>
          <div className="crumb">Models / hipfire library</div>
          <h1>Model library</h1>
        </div>
        <div className="head-meta">
          <span className="badge ghost mono">{models.length} tags</span>
          <button
            className="btn"
            onClick={() => refresh().catch(() => {})}
            disabled={loading}
            title="Re-scan hipfire's local registry"
          >
            <I.Refresh
              size={12}
              style={{ animation: loading ? "spin 0.9s linear infinite" : "none" }}
            />{" "}
            Re-scan
          </button>
        </div>
      </div>

      <div className="page-body">
        {error && (
          <div className="badge red" style={{ alignSelf: "flex-start", fontSize: 11, marginBottom: 12 }}>
            Couldn&apos;t list local models: {error}
          </div>
        )}

        <div className="prof-toolbar" style={{ marginBottom: 16 }}>
          <div className="prof-search">
            <I.Search />
            <input
              placeholder="Filter by tag or file…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <span className="badge ghost mono">
            {rows.length} {rows.length === 1 ? "row" : "rows"}
          </span>
        </div>

        {rows.length === 0 ? (
          <div
            style={{
              padding: "40px 24px",
              textAlign: "center",
              color: "var(--muted)",
              fontSize: 13,
              border: "1px dashed var(--border)",
              borderRadius: "var(--radius-lg)",
            }}
          >
            {loading ? (
              "Scanning…"
            ) : models.length === 0 ? (
              <>
                No local hipfire models yet — pull one from <strong>Catalog</strong>, or convert a
                GGUF into hipfire&apos;s store on <strong>Configure</strong>.
              </>
            ) : (
              "No models match your filter."
            )}
          </div>
        ) : (
          <div className="model-table">
            {rows.map((m) => {
              const isLoaded = m.tag === hipfireTag;
              const serving = isServing(m.tag);
              const isDraft = m.tag.endsWith("-draft");
              return (
                <div
                  key={m.tag}
                  className={"model-row" + (isLoaded ? " loaded-row" : "")}
                  style={{
                    gridTemplateColumns: "minmax(160px, 1fr) minmax(160px, 1.6fr) 90px auto auto",
                  }}
                  onContextMenu={(e) => openMenu(e, rowMenuItems(m))}
                >
                  <div className="model-row-name">
                    <span className="quant-tag mono">{m.tag}</span>
                    {isDraft && (
                      <span
                        className="badge ghost"
                        style={{ fontSize: 9.5, padding: "1px 5px" }}
                        title="Speculative-decoding draft — pairs with its target model"
                      >
                        draft
                      </span>
                    )}
                    {isLoaded &&
                      (serving ? (
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
                  <div className="model-row-owner mono" title={m.file}>
                    {m.file}
                  </div>
                  <div className="model-row-cell mono" style={{ textAlign: "right" }}>
                    {m.size}
                  </div>
                  <button
                    className="btn"
                    style={{ padding: "3px 9px" }}
                    onClick={() => doServe(m.tag)}
                    disabled={serving}
                    title={serving ? "Already serving" : "Serve this tag & restart the server"}
                  >
                    {serving ? (
                      <>
                        <I.Check size={11} /> Loaded
                      </>
                    ) : (
                      <>
                        <I.Play size={11} /> Serve
                      </>
                    )}
                  </button>
                  <button
                    className="iconbtn"
                    onClick={() => doDelete(m).catch(() => {})}
                    disabled={serving}
                    title={serving ? "Currently being served — stop the server first" : "Delete from hipfire's store"}
                  >
                    <I.Trash size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

// ── Expanded row ─────────────────────────────────────────────────────────────
export function ExpandedRow({
  row,
  info,
  flags,
  setFlag,
  onLoad,
  isLoaded,
}: Readonly<{
  row: FlatRow;
  info: GgufInfo | "loading" | "error" | undefined;
  flags: Record<string, string | number | boolean>;
  setFlag: (k: string, v: string | number | boolean) => void;
  onLoad: () => void;
  isLoaded: boolean;
}>) {
  const ctx = (flags.ctx as number) ?? 32768;
  const ngl = (flags.ngl as number) ?? 30;
  const fa = !!flags.fa;
  const meta = info && info !== "loading" && info !== "error" ? info : undefined;
  // ctx slider is bounded by the model's native context when known — no more
  // flooring to 131072, so an 8k/32k model can't be configured past its window.
  const nativeCtx = meta?.context_length ? Number(meta.context_length) : undefined;
  const ctxMax = nativeCtx ?? 131072;
  // Keep the usual 2048 floor, but never let min exceed max for tiny-ctx models.
  const ctxMin = Math.min(2048, ctxMax);
  const ctxDisplay = Math.max(ctxMin, Math.min(ctxMax, ctx));
  // Flag (don't silently mutate) a stale ctx carried over from a bigger model.
  const ctxOverMax = ctx > ctxMax;
  const commitCtx = () => {
    const clamped = Math.max(ctxMin, Math.min(ctxMax, ctx));
    if (clamped !== ctx) setFlag("ctx", clamped);
  };
  // ngl slider tracks the real layer count when known; "all" still maps to the
  // 999 sentinel, and unchecking "all" lands on the explicit layer count.
  const nativeLayers = meta?.block_count ? Number(meta.block_count) : undefined;
  const nglMax = nativeLayers ?? 100;
  const isAllLayers = ngl === 999;
  const nglDisplay = isAllLayers ? nglMax : Math.max(0, Math.min(nglMax, ngl));

  return (
    <div className="model-row-expand">
      <div>
        <h4>Info</h4>
        <div className="row-ctrl">
          <div className="row-ctrl-line">
            <span className="lbl">file</span>
            <span
              className="mono"
              style={{
                fontSize: 11,
                color: "var(--text-2)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
              title={row.quant.path}
            >
              {row.quant.filename}
            </span>
          </div>
          {info === "loading" && (
            <div className="row-ctrl-line">
              <span style={{ color: "var(--muted)" }}>Inspecting GGUF…</span>
            </div>
          )}
          {info === "error" && (
            <div className="row-ctrl-line">
              <span style={{ color: "var(--red)" }}>Inspection failed</span>
            </div>
          )}
          {info && info !== "loading" && info !== "error" && (
            <>
              <div className="row-ctrl-line">
                <span className="lbl">arch</span>
                <span className="mono">{info.architecture ?? "?"}</span>
              </div>
              <div className="row-ctrl-line">
                <span className="lbl">MTP</span>
                <span
                  className={"badge " + (info.mtp_support ? "accent" : "ghost")}
                  style={{ fontSize: 10 }}
                >
                  {info.mtp_support ? "✓ filename" : "not detected"}
                </span>
              </div>
              {info.context_length && (
                <div className="row-ctrl-line">
                  <span className="lbl">native ctx</span>
                  <span className="mono">{info.context_length.toLocaleString()}</span>
                </div>
              )}
              {info.block_count && (
                <div className="row-ctrl-line">
                  <span className="lbl">layers</span>
                  <span className="mono">{info.block_count.toLocaleString()}</span>
                </div>
              )}
              <div className="row-ctrl-line">
                <span className="lbl">tensors</span>
                <span className="mono">{info.tensor_count.toLocaleString()}</span>
              </div>
            </>
          )}
        </div>
      </div>

      <div>
        <h4>Quick load params</h4>
        <div className="row-ctrl">
          <div className="row-ctrl-line">
            <span className="lbl" title="Context window in tokens">
              ctx
            </span>
            <input
              type="range"
              min={ctxMin}
              max={ctxMax}
              step={1024}
              value={ctxDisplay}
              onChange={(e) => setFlag("ctx", Number(e.target.value))}
              style={{ flex: 1 }}
            />
            <input
              className="input num mono"
              style={{ width: 80, ...(ctxOverMax ? { borderColor: "var(--red)" } : null) }}
              value={ctx}
              onChange={(e) => {
                // Keep typing free (so "40" en route to "4096" isn't snapped);
                // clamp on blur instead.
                const n = Number(e.target.value);
                if (Number.isFinite(n)) setFlag("ctx", n);
              }}
              onBlur={commitCtx}
              aria-invalid={ctxOverMax || undefined}
              title={ctxOverMax ? `Above native context (${ctxMax.toLocaleString()})` : undefined}
            />
          </div>
          {ctxOverMax && nativeCtx && (
            <div className="row-ctrl-line">
              <span style={{ fontSize: 10.5, color: "var(--red)" }}>
                Above this model&apos;s native context ({ctxMax.toLocaleString()}) — clamped on
                commit.
              </span>
            </div>
          )}

          <div className="row-ctrl-line">
            <span
              className="lbl"
              title="Model layers offloaded to GPU — 'all' offloads every layer"
            >
              ngl
            </span>
            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                fontSize: 11,
                color: isAllLayers ? "var(--accent)" : "var(--muted)",
                cursor: "pointer",
                userSelect: "none",
              }}
            >
              <input
                type="checkbox"
                checked={isAllLayers}
                onChange={(e) => setFlag("ngl", e.target.checked ? 999 : nglMax)}
                style={{ margin: 0 }}
              />{" "}
              all
            </label>
            <input
              type="range"
              min={0}
              max={nglMax}
              step={1}
              value={nglDisplay}
              onChange={(e) => setFlag("ngl", Number(e.target.value))}
              disabled={isAllLayers}
              style={{ flex: 1, opacity: isAllLayers ? 0.5 : 1 }}
            />
            <input
              className="input num mono"
              style={{ width: 60 }}
              value={isAllLayers ? "all" : nglDisplay}
              onChange={(e) => setFlag("ngl", Number(e.target.value) || 0)}
              disabled={isAllLayers}
            />
          </div>

          <div className="row-ctrl-line">
            <span className="lbl" title="Flash attention — faster on supported GPUs">
              flash-attn
            </span>
            <button className={"toggle" + (fa ? " on" : "")} onClick={() => setFlag("fa", !fa)} />
            <span style={{ fontSize: 11, color: "var(--muted)" }}>{fa ? "on" : "off"}</span>
          </div>
        </div>
      </div>

      <div>
        <h4>Apply</h4>
        <div className="row-ctrl" style={{ justifyContent: "space-between" }}>
          <span style={{ fontSize: 11.5, color: "var(--muted)" }}>
            <I.Info size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
            Load sets <span className="mono">--model</span>, applies the params above, and restarts
            the server so the model is live.
          </span>
          <div className="actions">
            <button className="btn primary" onClick={onLoad} disabled={isLoaded}>
              <I.Play size={12} /> {isLoaded ? "Loaded" : "Load this quant"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
