import { useEffect, useMemo, useState } from "react";
import { I } from "../icons";
import {
  api,
  type EngineAsset,
  type EngineRelease,
  type HipfireDiagResult,
  type InstalledEngine,
} from "../lib/api";
import { useAppStore } from "../state";
import { useShallow } from "zustand/react/shallow";
import { useContextMenu, type MenuItem } from "../components/ContextMenu";
import { useConfirm } from "../components/ConfirmDialog";
import { log } from "../lib/logger";

// Plain-English guidance for the accelerator variants, so the filter/badges
// aren't bare jargon ("vulkan", "hip", "cuda"). Keyed on the leading token so
// "hip-gfx1100" still resolves to the HIP hint.
const VARIANT_HINT: Record<string, string> = {
  vulkan: "Works on most GPUs (AMD/Intel/NVIDIA)",
  cuda: "NVIDIA GPUs only",
  hip: "AMD GPUs via ROCm",
  cpu: "No GPU acceleration",
};

function variantHint(variant: string | null | undefined): string | undefined {
  if (!variant) return undefined;
  const key = variant.toLowerCase().split(/[-\s]/)[0];
  return VARIANT_HINT[key];
}

function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} B`;
}

function relTime(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const PHASE_LABEL: Record<string, string> = {
  download: "Downloading",
  extract: "Extracting",
  scan: "Finalizing",
};

function InstalledRow({
  engine,
  busy,
  onActivate,
  onDelete,
}: Readonly<{
  engine: InstalledEngine;
  busy: boolean;
  onActivate: () => void;
  onDelete: () => void;
}>) {
  const openMenu = useContextMenu();
  const { confirmElement, confirm } = useConfirm();
  const meta = [
    engine.version,
    engine.commit,
    ...(engine.backend_badges ?? []),
    engine.size,
    engine.installed_at ? `installed ${relTime(engine.installed_at)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  // Single confirmed-delete path shared by the trash icon and the context menu,
  // so deleting an engine always asks first (the icon used to delete instantly).
  const requestDelete = async () => {
    const ok = await confirm({
      title: `Delete engine "${engine.tag ?? engine.id}"?`,
      body: "This removes the downloaded engine from disk. You can re-download it later.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (ok) onDelete();
  };
  const menuItems = (): MenuItem[] => [
    {
      label: "Activate",
      icon: "Check",
      disabled: engine.active,
      onClick: onActivate,
    },
    "separator",
    {
      label: "Reveal in Explorer",
      icon: "Folder",
      onClick: () => api.revealInExplorer(engine.path).catch(() => {}),
    },
    {
      label: "Copy path",
      icon: "Copy",
      onClick: () => navigator.clipboard?.writeText(engine.path).catch(() => {}),
    },
    "separator",
    {
      label: "Delete engine…",
      icon: "Trash",
      danger: true,
      disabled: engine.active || busy,
      hint: engine.active ? "in use" : undefined,
      onClick: () => {
        requestDelete().catch(() => {});
      },
    },
  ];
  return (
    <>
      {confirmElement}
      <div
        className={"engine-row" + (engine.active ? " active" : "")}
        onContextMenu={(e) => openMenu(e, menuItems())}
      >
        <div className="engine-row-icon">
          {engine.active ? <I.Bolt size={14} /> : <I.Cpu size={14} />}
        </div>
        <div className="engine-row-main">
          <div className="engine-row-name mono">
            {engine.tag ?? engine.id}
            {engine.variant && (
              <span
                className="badge ghost mono"
                style={{ marginLeft: 6, fontSize: 10 }}
                title={variantHint(engine.variant)}
              >
                {engine.variant}
                {engine.arch ? ` · ${engine.arch}` : ""}
              </span>
            )}
            {engine.active && (
              <span className="badge accent" style={{ marginLeft: 6, fontSize: 9.5 }}>
                active
              </span>
            )}
          </div>
          <div className="engine-row-desc">{meta || engine.id}</div>
        </div>
        <div className="engine-row-actions">
          {engine.active ? (
            <span className="badge green" style={{ fontSize: 10 }}>
              <span className="dot" /> in use
            </span>
          ) : (
            <button className="btn" onClick={onActivate} title="Make this the active engine">
              <I.Check size={12} /> Activate
            </button>
          )}
          <button
            className="iconbtn"
            onClick={() => requestDelete().catch(() => {})}
            disabled={engine.active || busy}
            title={
              engine.active
                ? "Switch to another engine first"
                : busy
                  ? "Wait for the current download to finish"
                  : "Delete this engine"
            }
          >
            <I.Trash size={13} />
          </button>
        </div>
      </div>
    </>
  );
}

function AssetRow({
  asset,
  installed,
  disabled,
  onDownload,
  onActivate,
}: Readonly<{
  asset: EngineAsset;
  installed: InstalledEngine | undefined;
  disabled: boolean;
  onDownload: () => void;
  onActivate: () => void;
}>) {
  return (
    <div className="engine-asset">
      <div className="engine-asset-main">
        <span className="badge ghost mono engine-variant" title={variantHint(asset.variant)}>
          {asset.variant}
          {asset.arch ? ` · ${asset.arch}` : ""}
        </span>
        <span className="engine-asset-name mono" title={asset.name}>
          {asset.name}
        </span>
      </div>
      <span className="engine-asset-size mono">{fmtBytes(asset.size)}</span>
      {installed ? (
        installed.active ? (
          <span className="badge green" style={{ fontSize: 10 }}>
            <span className="dot" /> active
          </span>
        ) : (
          <button
            className="btn ghost"
            onClick={onActivate}
            title="Already downloaded — activate it"
          >
            <I.Check size={12} /> Activate
          </button>
        )
      ) : (
        <button className="btn primary" onClick={onDownload} disabled={disabled}>
          <I.Download size={12} /> Download
        </button>
      )}
    </div>
  );
}

export function EngineManagerScreen() {
  const engineKind = useAppStore((s) => s.settings.engine_kind);
  // hipfire has no release/build manager of its own (its binary path is set
  // on Configure) — render a health/diagnostics page instead. The llama
  // branch below (and everything it renders) is untouched by this check.
  if (engineKind === "hipfire") return <HipfireDiagScreen />;
  return <LlamaEngineManagerScreen />;
}

function LlamaEngineManagerScreen() {
  const {
    build,
    installedEngines,
    engineReleases,
    engineReleasesLoading,
    engineReleasesError,
    engineDownload,
    engineError,
    engineVariantFilter,
    fetchEngineReleases,
    refreshInstalledEngines,
    startEngineDownload,
    cancelEngineDownload,
    deleteEngine,
    activateEngine,
    setEngineVariantFilter,
  } = useAppStore(
    useShallow((s) => ({
      build: s.build,
      installedEngines: s.installedEngines,
      engineReleases: s.engineReleases,
      engineReleasesLoading: s.engineReleasesLoading,
      engineReleasesError: s.engineReleasesError,
      engineDownload: s.engineDownload,
      engineError: s.engineError,
      engineVariantFilter: s.engineVariantFilter,
      fetchEngineReleases: s.fetchEngineReleases,
      refreshInstalledEngines: s.refreshInstalledEngines,
      startEngineDownload: s.startEngineDownload,
      cancelEngineDownload: s.cancelEngineDownload,
      deleteEngine: s.deleteEngine,
      activateEngine: s.activateEngine,
      setEngineVariantFilter: s.setEngineVariantFilter,
    })),
  );

  // Lazy-load on first open: cached releases skip the network, installed list
  // always refreshes so `active` flags reflect the current build dir.
  useEffect(() => {
    // Drop any stale error from a previous visit before re-fetching;
    // refreshInstalledEngines may set a fresh one if the read fails.
    useAppStore.setState({ engineError: null });
    refreshInstalledEngines().catch(() => {});
    fetchEngineReleases().catch(() => {});
  }, [refreshInstalledEngines, fetchEngineReleases]);

  const installedById = useMemo(() => {
    const m = new Map<string, InstalledEngine>();
    for (const e of installedEngines) m.set(e.id, e);
    return m;
  }, [installedEngines]);

  // All accelerator variants offered across the fetched releases, for the filter.
  const variants = useMemo(() => {
    const set = new Set<string>();
    for (const r of engineReleases) for (const a of r.assets) set.add(a.variant);
    return Array.from(set).sort();
  }, [engineReleases]);

  // Releases that have at least one asset matching the active filter.
  const filteredReleases = useMemo(() => {
    const match = (a: EngineAsset) =>
      engineVariantFilter === "all" || a.variant === engineVariantFilter;
    return engineReleases
      .map((r) => ({ release: r, assets: r.assets.filter(match) }))
      .filter((x) => x.assets.length > 0);
  }, [engineReleases, engineVariantFilter]);

  const downloading = engineDownload != null;
  const dlPct =
    engineDownload && engineDownload.total > 0
      ? Math.min(100, (engineDownload.downloaded / engineDownload.total) * 100)
      : 0;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="crumb">Engine / llama.cpp</div>
          <h1>Engine manager</h1>
          <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 4 }}>
            Manages llama.cpp release downloads and installed builds — the hipfire engine binary is
            set separately on the <strong>Configure</strong> screen.
          </div>
        </div>
        <div className="head-meta">
          {build?.detected && build.version ? (
            <span className="badge ghost mono" title="Active engine (build directory)">
              <I.Bolt size={11} /> {build.version}
              {build.backend_badges.length ? ` · ${build.backend_badges[0]}` : ""}
            </span>
          ) : (
            <span className="badge ghost">no active engine</span>
          )}
          <button
            className="btn"
            onClick={() => fetchEngineReleases(true).catch(() => {})}
            disabled={engineReleasesLoading}
            title="Re-fetch releases from GitHub"
          >
            <I.Refresh
              size={12}
              style={{ animation: engineReleasesLoading ? "spin 0.9s linear infinite" : "none" }}
            />{" "}
            Refresh
          </button>
        </div>
      </div>

      <div className="page-body" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {engineError && !downloading && (
          <div className="panel">
            <div
              className="panel-body"
              style={{
                fontSize: 12.5,
                color: "var(--red)",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <I.X size={12} style={{ flexShrink: 0 }} />
              <span style={{ flex: 1 }}>{engineError}</span>
              <button
                className="btn ghost"
                style={{ color: "var(--text)" }}
                onClick={() => refreshInstalledEngines().catch(() => {})}
                title="Re-read the installed engines"
              >
                <I.Refresh size={12} /> Retry
              </button>
            </div>
          </div>
        )}

        {/* ── Active download ── */}
        {downloading && engineDownload && (
          <div className="panel">
            <div className="panel-head">
              <I.Download size={14} /> {PHASE_LABEL[engineDownload.phase] ?? "Working"}{" "}
              <span className="mono" style={{ marginLeft: 4 }}>
                {engineDownload.id}
              </span>
              <button
                className="btn ghost"
                style={{ marginLeft: "auto" }}
                onClick={() => cancelEngineDownload().catch(() => {})}
              >
                <I.X size={11} /> Cancel
              </button>
            </div>
            <div
              className="panel-body"
              style={{ display: "flex", flexDirection: "column", gap: 8 }}
            >
              <div className="engine-track">
                <div
                  className="engine-fill"
                  style={{
                    width: `${engineDownload.phase === "download" ? Math.max(2, dlPct) : 100}%`,
                  }}
                />
              </div>
              <div className="mono" style={{ fontSize: 11.5, color: "var(--muted)" }}>
                {engineDownload.phase === "download"
                  ? `${fmtBytes(engineDownload.downloaded)} / ${
                      engineDownload.total > 0 ? fmtBytes(engineDownload.total) : "?"
                    } · ${dlPct.toFixed(0)}%`
                  : engineDownload.phase === "extract"
                    ? "Extracting archive…"
                    : "Detecting version & writing manifest…"}
              </div>
            </div>
          </div>
        )}

        {/* ── Installed ── */}
        <div className="panel">
          <div className="panel-head">
            <I.Cpu size={14} /> Installed
            <span className="meta" style={{ marginLeft: "auto" }}>
              {installedEngines.length} version{installedEngines.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="panel-body">
            {installedEngines.length === 0 ? (
              <div style={{ fontSize: 12.5, color: "var(--muted)" }}>
                No engines downloaded yet. Pick one from <strong>Available</strong> below — it
                installs into the app&apos;s engine library and you can switch between versions with
                one click. Your manually-selected build (Configure → Binary) keeps working
                regardless.
              </div>
            ) : (
              <div className="engine-list">
                {installedEngines.map((e) => (
                  <InstalledRow
                    key={e.id}
                    engine={e}
                    busy={downloading}
                    onActivate={() => activateEngine(e.path).catch(() => {})}
                    onDelete={() => deleteEngine(e.id).catch(() => {})}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── Available ── */}
        <div className="panel">
          <div className="panel-head">
            <I.Download size={14} /> Available
            <span
              className="meta"
              style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}
            >
              <select
                className="select"
                value={engineVariantFilter}
                onChange={(e) => setEngineVariantFilter(e.target.value)}
                title="Filter by accelerator variant"
              >
                <option value="all" title="All accelerator variants">
                  All variants
                </option>
                {variants.map((v) => (
                  <option key={v} value={v} title={variantHint(v)}>
                    {v}
                  </option>
                ))}
              </select>
            </span>
          </div>
          <div className="panel-body">
            {engineReleasesError ? (
              <div
                style={{
                  fontSize: 12.5,
                  color: "var(--red)",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <I.X size={12} style={{ flexShrink: 0 }} />
                <span style={{ flex: 1 }}>{engineReleasesError}</span>
                <button
                  className="btn ghost"
                  style={{ color: "var(--text)" }}
                  onClick={() => fetchEngineReleases(true).catch(() => {})}
                  disabled={engineReleasesLoading}
                  title="Re-fetch releases from GitHub"
                >
                  <I.Refresh
                    size={12}
                    style={{
                      animation: engineReleasesLoading ? "spin 0.9s linear infinite" : "none",
                    }}
                  />{" "}
                  Retry
                </button>
              </div>
            ) : engineReleasesLoading && engineReleases.length === 0 ? (
              <div style={{ fontSize: 12.5, color: "var(--muted)" }}>Loading releases…</div>
            ) : filteredReleases.length === 0 ? (
              <div style={{ fontSize: 12.5, color: "var(--muted)" }}>
                No <span className="mono">{engineVariantFilter}</span> builds in the latest
                releases. Try a different variant.
              </div>
            ) : (
              <div className="engine-releases">
                {filteredReleases.map(({ release, assets }) => (
                  <ReleaseBlock
                    key={release.tag}
                    release={release}
                    assets={assets}
                    installedById={installedById}
                    downloading={downloading}
                    onDownload={(a) => startEngineDownload(a, release.tag).catch(() => {})}
                    onActivate={(path) => activateEngine(path).catch(() => {})}
                  />
                ))}
              </div>
            )}
            <div className="engine-source mono">
              <I.Info size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
              from github.com/ggml-org/llama.cpp · {engineReleases.length} releases
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// ── hipfire diag ─────────────────────────────────────────────────────────────
// `hipfire diag` (~10s — a live HIP GPU probe) as a sectioned health page:
// engine status, GPU, kernels, local models, config, plus a collapsible raw
// output. One-shot on mount + a manual refresh (unlike the streaming
// commands elsewhere, diag has no progress to show along the way — just a
// loading state for the probe window).
function DiagRow({ label, value }: Readonly<{ label: string; value: React.ReactNode }>) {
  return (
    <div className="row-ctrl-line">
      <span className="lbl">{label}</span>
      <span className="mono">{value}</span>
    </div>
  );
}

function HipfireDiagScreen() {
  const hipfirePath = useAppStore((s) => s.settings.hipfire_path);
  const [result, setResult] = useState<HipfireDiagResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.hipfireDiag(hipfirePath);
      setResult(res);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      log.warn("hipfire", "hipfire_diag failed", { error: msg });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hipfirePath]);

  const diag = result?.diag;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="crumb">Engine / hipfire</div>
          <h1>Engine health</h1>
          <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 4 }}>
            Live diagnostics from <span className="mono">hipfire diag</span> — the hipfire engine
            binary itself is set on the <strong>Configure</strong> screen.
          </div>
        </div>
        <div className="head-meta">
          {diag?.daemon_found != null && (
            <span className={"badge " + (diag.daemon_found ? "green" : "red")}>
              <span className="dot" /> daemon {diag.daemon_found ? "found" : "not found"}
            </span>
          )}
          <button
            className="btn"
            onClick={() => refresh().catch(() => {})}
            disabled={loading}
            title="Re-run hipfire diag (~10s — live GPU probe)"
          >
            <I.Refresh
              size={12}
              style={{ animation: loading ? "spin 0.9s linear infinite" : "none" }}
            />{" "}
            {loading ? "Probing…" : "Refresh"}
          </button>
        </div>
      </div>

      <div className="page-body" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {error && (
          <div className="panel">
            <div
              className="panel-body"
              style={{ fontSize: 12.5, color: "var(--red)", display: "flex", alignItems: "center", gap: 8 }}
            >
              <I.X size={12} style={{ flexShrink: 0 }} />
              <span style={{ flex: 1 }}>Couldn&apos;t run hipfire diag: {error}</span>
              <button
                className="btn ghost"
                style={{ color: "var(--text)" }}
                onClick={() => refresh().catch(() => {})}
                disabled={loading}
              >
                <I.Refresh size={12} /> Retry
              </button>
            </div>
          </div>
        )}

        {loading && !result && (
          <div className="panel">
            <div className="panel-body" style={{ fontSize: 12.5, color: "var(--muted)" }}>
              <I.Info size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
              Probing GPU via HIP runtime… this can take about 10 seconds.
            </div>
          </div>
        )}

        {diag && (
          <>
            <div className="panel">
              <div className="panel-head">
                <I.Gpu size={14} /> GPU
              </div>
              <div className="panel-body">
                {diag.gpu ? (
                  <div className="row-ctrl">
                    <DiagRow label="arch" value={diag.gpu.arch ?? "—"} />
                    <DiagRow label="HIP version" value={diag.gpu.hip_version ?? "—"} />
                    <DiagRow
                      label="VRAM"
                      value={
                        diag.gpu.vram_free_mb != null && diag.gpu.vram_total_mb != null
                          ? `${diag.gpu.vram_free_mb.toLocaleString()} / ${diag.gpu.vram_total_mb.toLocaleString()} MB free`
                          : "—"
                      }
                    />
                    <DiagRow label="kv default" value={diag.gpu.kv_default ?? "—"} />
                    <DiagRow label="WMMA" value={diag.gpu.wmma ?? "—"} />
                  </div>
                ) : (
                  <div style={{ fontSize: 12.5, color: "var(--muted)" }}>
                    No GPU probe reported (hipcc/rocminfo unavailable, or the probe failed).
                  </div>
                )}
              </div>
            </div>

            <div className="panel">
              <div className="panel-head">
                <I.Cpu size={14} /> Kernels
                <span className="meta" style={{ marginLeft: "auto" }}>
                  {diag.kernels.length} arch{diag.kernels.length === 1 ? "" : "es"} with blobs
                </span>
              </div>
              <div className="panel-body">
                {diag.kernels.length === 0 ? (
                  <div style={{ fontSize: 12.5, color: "var(--muted)" }}>
                    No pre-compiled kernel blobs found for any arch.
                  </div>
                ) : (
                  <div className="row-ctrl">
                    {diag.kernels.map((k) => (
                      <DiagRow
                        key={k.arch}
                        label={k.arch}
                        value={`${k.blobs} blobs, ${k.hashes} hashes`}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="panel">
              <div className="panel-head">
                <I.Folder size={14} /> Local models
                <span className="meta" style={{ marginLeft: "auto" }}>
                  {diag.local_models.length}
                </span>
              </div>
              <div className="panel-body">
                {diag.local_models.length === 0 ? (
                  <div style={{ fontSize: 12.5, color: "var(--muted)" }}>
                    No local models registered.
                  </div>
                ) : (
                  <div className="row-ctrl">
                    {diag.local_models.map((m) => (
                      <DiagRow key={m.name} label={m.name} value={m.size} />
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="panel">
              <div className="panel-head">
                <I.Sliders size={14} /> Config
                {diag.config_path && (
                  <span className="meta mono" style={{ marginLeft: "auto" }} title={diag.config_path}>
                    {diag.config_path}
                  </span>
                )}
              </div>
              <div className="panel-body">
                {diag.config.length === 0 ? (
                  <div style={{ fontSize: 12.5, color: "var(--muted)" }}>
                    No config file found.
                  </div>
                ) : (
                  <div className="row-ctrl">
                    {diag.config.map(([k, v]) => (
                      <DiagRow key={k} label={k} value={v} />
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="panel">
              <div className="panel-body">
                <button className="btn ghost" onClick={() => setShowRaw((v) => !v)}>
                  <I.ChevR
                    size={11}
                    style={{
                      transform: showRaw ? "rotate(90deg)" : undefined,
                      transition: "transform 0.15s",
                    }}
                  />{" "}
                  {showRaw ? "Hide" : "Show"} raw output
                </button>
                {showRaw && (
                  <div className="bench-progress" style={{ marginTop: 8 }}>
                    {result?.output || "(empty)"}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function ReleaseBlock({
  release,
  assets,
  installedById,
  downloading,
  onDownload,
  onActivate,
}: Readonly<{
  release: EngineRelease;
  assets: EngineAsset[];
  installedById: Map<string, InstalledEngine>;
  downloading: boolean;
  onDownload: (a: EngineAsset) => void;
  onActivate: (path: string) => void;
}>) {
  const date = release.published_at ? release.published_at.slice(0, 10) : "";
  return (
    <div className="engine-release">
      <div className="engine-release-head">
        <span className="mono engine-release-tag">{release.tag}</span>
        {date && <span className="engine-release-date">{date}</span>}
      </div>
      <div className="engine-release-assets">
        {assets.map((a) => {
          const installed = installedById.get(a.id);
          return (
            <AssetRow
              key={a.name}
              asset={a}
              installed={installed}
              disabled={downloading}
              onDownload={() => onDownload(a)}
              onActivate={() => installed && onActivate(installed.path)}
            />
          );
        })}
      </div>
    </div>
  );
}
