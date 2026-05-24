import { useMemo, useState } from "react";
import { I } from "../icons";
import { useAppStore } from "../state";
import { useShallow } from "zustand/react/shallow";
import { api, type GgufInfo, type ModelEntry, type OwnerEntry, type QuantFile } from "../lib/api";

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
    server,
    startServer,
    stopServer,
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
      server: s.server,
      startServer: s.startServer,
      stopServer: s.stopServer,
    })),
  );

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

  const onLoad = async (p: string, opts: { altRestart?: boolean } = {}) => {
    loadModelPath(p);
    if (opts.altRestart && server.running) {
      // Quick swap: stop + restart with current flags.
      // Re-using the server's existing flags rather than building a new argv
      // from the page-level flags map. The user can hit Reload on Configure
      // for a full restart if they want different args.
      await stopServer();
      // Note: we deliberately don't auto-start here — startServer needs the
      // assembled argv, which lives in Configure's args builder. The user
      // can press Start on Configure.
      void startServer;
    }
  };

  return (
    <>
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
                  >
                    <I.History size={12} /> Recent
                  </button>
                  {showRecent && settings.models_recent.length > 0 && (
                    <div className="recent-pop">
                      {settings.models_recent.map((p) => (
                        <button
                          key={p}
                          className="recent-item mono"
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
                — click a row to inspect & quick-config before loading. Alt-click Load to skip the
                inline panel.
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
                      {isLoaded && (
                        <span
                          className="badge green"
                          style={{ fontSize: 9.5, padding: "1px 5px" }}
                          title="Currently set as --model"
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
                        // Alt-click → quick load, bypassing expansion
                        if (e.altKey) {
                          onLoad(r.quant.path, { altRestart: true }).catch(() => {});
                        } else {
                          onToggle(key, r.quant.path);
                        }
                      }}
                      title={
                        isLoaded
                          ? "Already loaded"
                          : "Click to configure & load · Alt-click to load directly"
                      }
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

// ── Expanded row ─────────────────────────────────────────────────────────────
export function ExpandedRow({
  row,
  info,
  flags,
  setFlag,
  onLoad,
  isLoaded,
}: {
  row: FlatRow;
  info: GgufInfo | "loading" | "error" | undefined;
  flags: Record<string, string | number | boolean>;
  setFlag: (k: string, v: string | number | boolean) => void;
  onLoad: () => void;
  isLoaded: boolean;
}) {
  const ctx = (flags.ctx as number) ?? 32768;
  const ngl = (flags.ngl as number) ?? 30;
  const fa = !!flags.fa;
  const ctxMax =
    info && info !== "loading" && info !== "error" && info.context_length
      ? Math.max(131072, Number(info.context_length))
      : 131072;
  const isAllLayers = ngl === 999;
  const nglDisplay = isAllLayers ? 100 : Math.max(0, Math.min(100, ngl));

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
            <span className="lbl">ctx</span>
            <input
              type="range"
              min={2048}
              max={ctxMax}
              step={1024}
              value={ctx}
              onChange={(e) => setFlag("ctx", Number(e.target.value))}
              style={{ flex: 1 }}
            />
            <input
              className="input num mono"
              style={{ width: 80 }}
              value={ctx}
              onChange={(e) => setFlag("ctx", Number(e.target.value) || 0)}
            />
          </div>

          <div className="row-ctrl-line">
            <span className="lbl">ngl</span>
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
                onChange={(e) => setFlag("ngl", e.target.checked ? 999 : 100)}
                style={{ margin: 0 }}
              />
              all
            </label>
            <input
              type="range"
              min={0}
              max={100}
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
            <span className="lbl">flash-attn</span>
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
            Load sets <span className="mono">--model</span> and applies the params above. Hit{" "}
            <strong>Start</strong> on Configure to actually launch the server.
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
