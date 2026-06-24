import { useEffect, useMemo } from "react";
import { I } from "../icons";
import { type EngineAsset, type EngineRelease, type InstalledEngine } from "../lib/api";
import { useAppStore } from "../state";
import { useShallow } from "zustand/react/shallow";

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
  const meta = [
    engine.version,
    engine.commit,
    ...(engine.backend_badges ?? []),
    engine.size,
    engine.installed_at ? `installed ${relTime(engine.installed_at)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className={"engine-row" + (engine.active ? " active" : "")}>
      <div className="engine-row-icon">
        {engine.active ? <I.Bolt size={14} /> : <I.Cpu size={14} />}
      </div>
      <div className="engine-row-main">
        <div className="engine-row-name mono">
          {engine.tag ?? engine.id}
          {engine.variant && (
            <span className="badge ghost mono" style={{ marginLeft: 6, fontSize: 10 }}>
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
          onClick={onDelete}
          disabled={engine.active || busy}
          title={engine.active ? "Switch to another engine first" : "Delete this engine"}
        >
          <I.Trash size={13} />
        </button>
      </div>
    </div>
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
        <span className="badge ghost mono engine-variant">
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
            <div className="panel-body" style={{ fontSize: 12.5, color: "var(--red)" }}>
              <I.X size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
              {engineError}
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
                <option value="all">All variants</option>
                {variants.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </span>
          </div>
          <div className="panel-body">
            {engineReleasesError ? (
              <div style={{ fontSize: 12.5, color: "var(--red)" }}>
                <I.X size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
                {engineReleasesError}
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
