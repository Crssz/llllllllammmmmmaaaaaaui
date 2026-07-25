import { useEffect, useMemo, useState } from "react";
import { I } from "../icons";
import { useAppStore } from "../state";
import { useShallow } from "zustand/react/shallow";
import { argvEqual } from "../state/slices/serverSlice";
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
import { buildArgs } from "../lib/buildArgs";
import { hipfireLoadedTag } from "../lib/buildHipfireArgs";
import { log } from "../lib/logger";

// No "recent": the scan carries no timestamp to sort by. `scan_models`
// (src-tauri/src/models_scan.rs) stats every file but keeps only its length,
// so QuantFile is {tag, filename, path, size_gb, bits, badges} all the way to
// the UI. "recent" used to be the DEFAULT option here and quietly did nothing
// — the rows stayed in raw scan order — which is worse than not offering it,
// so it's gone and "name" is the honest default. Bringing it back needs a real
// mtime on the Rust QuantFile (e.g. `modified_ms` from the metadata() call
// models_scan.rs already makes per file); nothing on the frontend can stand in
// for it — models_recent tracks folders, and model_configs is keyed by path
// with no timestamps.
type SortBy = "name" | "size";

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

// The GGUF the RUNNING llama-server was actually launched with, recovered from
// serverSlice's `loadedArgs` (the exact argv startServer used) rather than from
// `flags.model` (the mutable NEXT-launch selection). Those two diverge the
// instant a model is picked without reloading — and after a stop they diverge
// completely, since flags.model survives while nothing is resident. Every
// "this row is live" claim therefore has to come from here, the same reason the
// hipfire panel below reads hipfireLoadedTag(loadedArgs) instead of
// hipfire_flags.tag. buildArgs emits the main model as "--model <path>"; the
// speculative drafters use "--model-draft", which this exact-token match can't
// collide with.
export function llamaLoadedModel(loadedArgs: string[] | null): string | null {
  if (!loadedArgs) return null;
  const i = loadedArgs.indexOf("--model");
  return i >= 0 && i + 1 < loadedArgs.length ? loadedArgs[i + 1] : null;
}

export type RowVerb = "Loaded" | "Reload" | "Start" | "Load" | "Apply";
export type RowAction = { verb: RowVerb; title: string; disabled: boolean };

/**
 * What a row's primary button actually does, derived from BOTH the selection
 * (`flags.model`) and what the server is genuinely running (`loadedArgs`).
 *
 * Keying it off the selection alone is what produced the dead end this
 * replaces: the selected model's button read a disabled "Loaded" even with the
 * server stopped, leaving no way to start the server for the model already
 * picked. "Loaded" is now the only disabled state, and it requires the server
 * to be up, running THIS file, with exactly the flags on screen.
 */
export function rowAction(o: {
  /** This row is `flags.model` — the next launch's target. */
  isSelected: boolean;
  /** The running server was launched with this row's file. */
  isRunningThis: boolean;
  /** The current flags would relaunch the running server byte-identically. */
  configMatches: boolean;
  serverRunning: boolean;
  /** The expanded editor holds quick-load params that aren't applied yet. */
  dirty?: boolean;
}): RowAction {
  const { isSelected, isRunningThis, configMatches, serverRunning, dirty } = o;
  // Unapplied params win over everything: the button's job is to commit them.
  if (dirty) {
    return {
      verb: "Apply",
      title: "Apply the params above to this model & restart the server",
      disabled: false,
    };
  }
  if (isRunningThis && configMatches) {
    return {
      verb: "Loaded",
      title: "Already loaded — the server is running this model with these flags",
      disabled: true,
    };
  }
  if (isRunningThis && isSelected) {
    return {
      verb: "Reload",
      title: "Flags changed since this model was loaded — restart the server to apply them",
      disabled: false,
    };
  }
  if (isSelected && !serverRunning) {
    return { verb: "Start", title: "Start the server with this model", disabled: false };
  }
  return {
    verb: "Load",
    title: serverRunning
      ? "Load this model & restart the server"
      : "Load this model & start the server",
    disabled: false,
  };
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
    loadedEngine,
    loadedArgs,
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
      loadedEngine: s.loadedEngine,
      loadedArgs: s.loadedArgs,
    })),
  );

  const { confirmElement, confirm } = useConfirm();
  const [showRecent, setShowRecent] = useState(false);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortBy>("name");
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  // Per-row arch / MTP info, fetched lazily when a row is expanded.
  const [rowInfo, setRowInfo] = useState<Record<string, GgufInfo | "loading" | "error">>({});

  const path = settings.models_dir ?? "";
  const totalGB = models?.total_gb ?? 0;
  const count = models?.count ?? 0;
  const ownersN = models?.owners ?? 0;
  const loadedKey = (flags.model as string) || "";
  // A failed re-scan leaves `models` holding the PREVIOUS directory's tree
  // (scanModels only overwrites it on success), so everything derived from it
  // — the row list, the counts, the "scanned" badge — is stale until the next
  // successful scan. Never dress that up as success.
  const staleScan = !!modelsScanError && count > 0;

  // What the server is genuinely running, as opposed to what's merely selected.
  // Null unless a llama server we launched ourselves is up: an adopted server
  // (loadedEngine/loadedArgs null) or a running hipfire daemon tells us nothing
  // about which GGUF is resident, so no row may claim to be it.
  const runningModel =
    server.running && loadedEngine === "llama" ? llamaLoadedModel(loadedArgs) : null;
  // Whether restarting right now would relaunch the running server unchanged —
  // the same argv diff serverSlice's reloadIfStale performs, so "loaded" here
  // means exactly "a chat would not force a reload".
  const pendingArgs = useMemo(() => buildArgs(flags), [flags]);
  const configMatchesRunning = !!loadedArgs && argvEqual(pendingArgs, loadedArgs);

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
    // `flat` is always a fresh array (flatten + filter both build one), so
    // sorting in place never reorders the scan tree in the store.
    if (sort === "size") {
      flat.sort((a, b) => b.quant.size_gb - a.quant.size_gb);
    } else {
      // Default. Not an `else if`: every SortBy must actually sort, or the
      // control is claiming an order it doesn't impose.
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

  // Deleting removes ALL split siblings, so block the delete whenever any
  // model the running server uses (main or speculative drafter) belongs to
  // the same split group — not just on exact path match. `runningModel` is
  // in the set alongside the flag values because those are the NEXT launch's
  // models: once the selection moves on without a reload, the file actually
  // held open by the server is only named by loadedArgs.
  //
  // Lives here, not inside modelMenuItems, because the row's visible Delete
  // button and the context menu's Delete item are two doors onto the same
  // deletion: one copy of the guard means they can't disagree about what the
  // server is holding open.
  const isDeleteBlocked = (r: FlatRow): boolean => {
    const inUsePaths = [
      loadedKey,
      runningModel ?? "",
      flags.model_draft as string,
      flags.model_draft_mtp as string,
      flags.model_draft_dflash as string,
    ].filter(Boolean);
    const rowKey = splitGroupKey(r.quant.path);
    return server.running && inUsePaths.some((p) => splitGroupKey(p) === rowKey);
  };

  const modelMenuItems = (r: FlatRow, act: RowAction, isSelected: boolean): MenuItem[] => {
    const deleteBlocked = isDeleteBlocked(r);
    return [
      {
        label: act.verb === "Start" ? "Start server with this model" : "Load & restart server",
        icon: "Play",
        disabled: act.disabled,
        onClick: () => onLoad(r.quant.path).catch(() => {}),
      },
      {
        label: "Set as model (no restart)",
        icon: "Check",
        disabled: isSelected,
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
            {!path ? (
              <span className="badge ghost" style={{ marginLeft: 6 }}>
                not selected
              </span>
            ) : modelsScanError ? (
              // Never a green "scanned" over a failed scan: the counts below it
              // describe the last directory that scanned cleanly, not this one.
              <span className="badge red" style={{ marginLeft: 6 }}>
                scan failed
              </span>
            ) : (
              <span className="badge green" style={{ marginLeft: 6 }}>
                <span className="dot" />
                scanned · {count} models · {ownersN} owners
              </span>
            )}
            {path && !modelsScanError && (
              <span className="sec-count">{totalGB.toFixed(1)} GB on disk</span>
            )}
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
            {staleScan && (
              <div className="badge yellow" style={{ alignSelf: "flex-start", fontSize: 11 }}>
                the {count} files listed below are from the last successful scan — they may not
                exist in this folder
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
          {staleScan && (
            <span
              className="badge yellow"
              title={`The last scan of ${path} failed — these rows come from the previous successful scan and may no longer be accurate.`}
            >
              stale
            </span>
          )}
          <span style={{ flex: 1 }} />
          <div className="segmented" role="group" aria-label="Sort rows">
            {(["name", "size"] as SortBy[]).map((s) => (
              <button
                key={s}
                className={sort === s ? "on" : ""}
                aria-pressed={sort === s}
                onClick={() => setSort(s)}
                title={
                  s === "name"
                    ? "Sort A→Z by owner / model / quant"
                    : "Sort by file size, largest first"
                }
              >
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
                : modelsScanError
                  ? "The scan failed — nothing to list. Fix the folder above and re-scan."
                  : count === 0
                    ? "No .gguf files found under <owner>/<model>/."
                    : "No models match your filter."}
          </div>
        ) : (
          <div className="model-table">
            {rows.map((r) => {
              const key = r.quant.path;
              const isSelected = key === loadedKey;
              // "Running this" is what the server is actually serving; "selected"
              // is only what the next launch would use. Keeping them apart is
              // what lets the button below offer Start on a stopped server.
              const isRunningThis = key === runningModel;
              const configMatches = isRunningThis && configMatchesRunning;
              const act = rowAction({
                isSelected,
                isRunningThis,
                configMatches,
                serverRunning: server.running,
              });
              const isExpanded = expandedKey === key;
              const deleteBlocked = isDeleteBlocked(r);
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
                      (isSelected ? " loaded-row" : "") +
                      (isExpanded ? " active" : "")
                    }
                    onContextMenu={(e) => openMenu(e, modelMenuItems(r, act, isSelected))}
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
                      {/* Only the row the server was actually launched with may
                          claim "loaded", and only while the flags on screen
                          still match the argv it was launched with — otherwise
                          say so instead of asserting a match that isn't there. */}
                      {isRunningThis ? (
                        configMatches ? (
                          <span
                            className="badge green"
                            style={{ fontSize: 9.5, padding: "1px 5px" }}
                            title="The server is running this model with the flags shown here"
                          >
                            <span className="dot" /> loaded
                          </span>
                        ) : (
                          <span
                            className="badge yellow"
                            style={{ fontSize: 9.5, padding: "1px 5px", whiteSpace: "nowrap" }}
                            title="The server is running this model, but the model/flags on screen have changed since it was launched — load or reload to apply them"
                          >
                            differs from running server
                          </span>
                        )
                      ) : (
                        isSelected && (
                          <span
                            className="badge ghost"
                            style={{ fontSize: 9.5, padding: "1px 5px" }}
                            title={
                              !server.running
                                ? "Set as --model — start the server to load it"
                                : runningModel
                                  ? "Set as --model, but the running server is serving something else — load it to switch"
                                  : "Set as --model — the running server wasn't started by this app, so what it has loaded is unknown"
                            }
                          >
                            selected
                          </span>
                        )
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
                    {/* Load + the file actions share one grid cell (a plain
                        wrapper div holding sibling buttons — never a button
                        inside a button, same shape as App.tsx's sidebar rows
                        and the hipfire table below), so the row keeps the
                        column count .model-row's template defines.

                        Reveal / copy path / delete are BUTTONS, not
                        context-menu-only entries: the menu opens on
                        contextmenu, which is a mouse event, so anything
                        reachable only from it is unreachable by keyboard —
                        and undiscoverable besides. The menu stays as a
                        superset (it also has copy filename, re-scan, set
                        without restart). */}
                    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <button
                        className="btn"
                        style={{ padding: "3px 9px" }}
                        onClick={() => onLoad(r.quant.path).catch(() => {})}
                        title={act.title}
                        disabled={act.disabled}
                      >
                        {act.disabled ? (
                          <>
                            <I.Check size={11} /> {act.verb}
                          </>
                        ) : (
                          <>
                            <I.Play size={11} /> {act.verb}
                          </>
                        )}
                      </button>
                      <button
                        className="iconbtn"
                        style={{ width: 22, height: 22 }}
                        onClick={() => api.revealInExplorer(r.quant.path).catch(() => {})}
                        title="Reveal in Explorer"
                        aria-label={`Reveal ${r.quant.filename} in Explorer`}
                      >
                        <I.Folder size={12} />
                      </button>
                      <button
                        className="iconbtn"
                        style={{ width: 22, height: 22 }}
                        onClick={() => navigator.clipboard?.writeText(r.quant.path).catch(() => {})}
                        title={`Copy path — ${r.quant.path}`}
                        aria-label={`Copy path of ${r.quant.filename}`}
                      >
                        <I.Copy size={12} />
                      </button>
                      {/* Same confirm-then-delete path as the menu item, and
                          the same in-use guard: a split sibling of anything
                          the running server holds open can't be deleted. */}
                      <button
                        className="iconbtn"
                        style={{ width: 22, height: 22 }}
                        onClick={() => {
                          onDeleteModel(r).catch(() => {});
                        }}
                        disabled={deleteBlocked}
                        title={
                          deleteBlocked
                            ? "In use by the running server — stop it before deleting"
                            : "Delete from disk…"
                        }
                        aria-label={`Delete ${r.quant.filename} from disk`}
                      >
                        <I.Trash size={12} />
                      </button>
                    </div>
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
                      isLoaded={isSelected}
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
  const {
    settings,
    server,
    loadedEngine,
    loadedArgs,
    setHipfireFlag,
    reloadServer,
    hipfireModelsVersion,
  } = useAppStore(
    useShallow((s) => ({
      settings: s.settings,
      server: s.server,
      loadedEngine: s.loadedEngine,
      loadedArgs: s.loadedArgs,
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
  // tag — derived from loadedArgs (the argv the running server was actually
  // launched with), NOT hipfireTag (settings.hipfire_flags.tag, the mutable
  // NEXT-launch selection). Those two diverge the instant the model picker
  // is changed without reloading (e.g. from Configure), so comparing against
  // hipfireTag would let a currently-served tag's guard silently stop firing
  // — see hipfireLoadedTag's doc comment. This delete guard has no OS
  // file-lock backstop (unlike llama's memory-mapped GGUF), so it must be
  // right.
  const isServing = (tag: string) =>
    server.running && loadedEngine === "hipfire" && tag === hipfireLoadedTag(loadedArgs);

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
          <div
            className="badge red"
            style={{ alignSelf: "flex-start", fontSize: 11, marginBottom: 12 }}
          >
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
                    title={
                      serving
                        ? "Currently being served — stop the server first"
                        : "Delete from hipfire's store"
                    }
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
  const { modelConfigs, server, loadedEngine, loadedArgs } = useAppStore(
    useShallow((s) => ({
      modelConfigs: s.settings.model_configs,
      server: s.server,
      loadedEngine: s.loadedEngine,
      loadedArgs: s.loadedArgs,
    })),
  );
  // The config THIS row would actually launch with: its own saved slot when it
  // has one, else the current flags — exactly what flagsSlice's
  // setFlag("model", …) does when it switches models. Everything below reads
  // from here rather than from `flags`, which describes the *loaded* model.
  const savedForRow = modelConfigs?.[row.quant.path] as Record<string, unknown> | undefined;
  // Freeze the no-saved-config fallback at mount (state, never updated):
  // loading a *different* row while this one stays expanded rewrites `flags`,
  // which would otherwise silently move this editor's baseline and make it look
  // edited when it isn't.
  const [inherited] = useState<Record<string, unknown>>(flags);
  const baseFlags: Record<string, unknown> = savedForRow ?? inherited;
  const baseline = {
    ctx: typeof baseFlags.ctx === "number" ? baseFlags.ctx : 32768,
    ngl: typeof baseFlags.ngl === "number" ? baseFlags.ngl : 30,
    fa: !!baseFlags.fa,
  };
  // Held as a draft rather than written through `setFlag`: every setFlag write
  // is persisted into `model_configs[flags.model]` (flagsSlice's applyPerModel),
  // so editing these live would rewrite the CURRENTLY LOADED model's saved
  // config — a control lying about its target — and then lose the edits anyway,
  // because Load restores this row's saved slot over the current flags. The
  // draft is committed to this row, in the right order, by applyAndLoad below.
  const [draft, setDraft] = useState(baseline);
  const dirty =
    draft.ctx !== baseline.ctx || draft.ngl !== baseline.ngl || draft.fa !== baseline.fa;
  const ctx = draft.ctx;
  const ngl = draft.ngl;
  const fa = draft.fa;
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
  const clampCtx = (v: number) => Math.max(ctxMin, Math.min(ctxMax, v));
  const commitCtx = () => {
    const clamped = clampCtx(ctx);
    if (clamped !== ctx) setDraft((d) => ({ ...d, ctx: clamped }));
  };
  // ngl slider tracks the real layer count when known; "all" still maps to the
  // 999 sentinel, and unchecking "all" lands on the explicit layer count.
  const nativeLayers = meta?.block_count ? Number(meta.block_count) : undefined;
  const nglMax = nativeLayers ?? 100;
  const isAllLayers = ngl === 999;
  const nglDisplay = isAllLayers ? nglMax : Math.max(0, Math.min(nglMax, ngl));

  // Same running-vs-selected derivation the table uses, so this button can't
  // disagree with the row's own button (or claim "Loaded" over a stopped
  // server), and so unapplied params always leave a way to commit them.
  const pendingArgs = useMemo(() => buildArgs(flags), [flags]);
  const runningModel =
    server.running && loadedEngine === "llama" ? llamaLoadedModel(loadedArgs) : null;
  const isRunningThis = row.quant.path === runningModel;
  const act = rowAction({
    isSelected: isLoaded,
    isRunningThis,
    configMatches: isRunningThis && !!loadedArgs && argvEqual(pendingArgs, loadedArgs),
    serverRunning: server.running,
    dirty,
  });

  const applyAndLoad = () => {
    const clamped = clampCtx(ctx);
    // Order matters. setFlag persists every write into
    // `model_configs[flags.model]`, so --model has to point at THIS row before
    // the params are written — otherwise they land on the previously-loaded
    // model. Writing them after the switch also makes them survive it: onLoad's
    // loadModelPath() re-reads the target's saved slot, which now holds exactly
    // these values.
    setFlag("model", row.quant.path);
    setFlag("ctx", clamped);
    setFlag("ngl", ngl);
    setFlag("fa", fa);
    if (clamped !== ctx) setDraft((d) => ({ ...d, ctx: clamped }));
    onLoad();
  };

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
        <h4>
          Quick load params
          {dirty && (
            <span
              className="badge yellow"
              style={{ fontSize: 9, padding: "0 4px", marginLeft: 6 }}
              title="Edited but not applied — Load writes these to this model and restarts the server"
            >
              unapplied
            </span>
          )}
        </h4>
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
              onChange={(e) => setDraft((d) => ({ ...d, ctx: Number(e.target.value) }))}
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
                if (Number.isFinite(n)) setDraft((d) => ({ ...d, ctx: n }));
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
                onChange={(e) => setDraft((d) => ({ ...d, ngl: e.target.checked ? 999 : nglMax }))}
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
              onChange={(e) => setDraft((d) => ({ ...d, ngl: Number(e.target.value) }))}
              disabled={isAllLayers}
              style={{ flex: 1, opacity: isAllLayers ? 0.5 : 1 }}
            />
            <input
              className="input num mono"
              style={{ width: 60 }}
              value={isAllLayers ? "all" : nglDisplay}
              onChange={(e) => setDraft((d) => ({ ...d, ngl: Number(e.target.value) || 0 }))}
              disabled={isAllLayers}
            />
          </div>

          <div className="row-ctrl-line">
            <span className="lbl" title="Flash attention — faster on supported GPUs">
              flash-attn
            </span>
            <button
              className={"toggle" + (fa ? " on" : "")}
              onClick={() => setDraft((d) => ({ ...d, fa: !d.fa }))}
            />
            <span style={{ fontSize: 11, color: "var(--muted)" }}>{fa ? "on" : "off"}</span>
          </div>
        </div>
      </div>

      <div>
        <h4>Apply</h4>
        <div className="row-ctrl" style={{ justifyContent: "space-between" }}>
          <span style={{ fontSize: 11.5, color: "var(--muted)" }}>
            <I.Info size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
            Load points <span className="mono">--model</span> at this quant, saves the params above
            as <em>its</em> config, and restarts the server so it&apos;s live.
          </span>
          <div className="actions">
            <button
              className="btn primary"
              onClick={applyAndLoad}
              disabled={act.disabled}
              title={act.title}
            >
              {act.disabled ? <I.Check size={12} /> : <I.Play size={12} />}{" "}
              {act.verb === "Load"
                ? "Load this quant"
                : act.verb === "Apply"
                  ? "Apply & load"
                  : act.verb}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
