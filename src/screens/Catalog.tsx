import { useEffect, useMemo, useState } from "react";
import { I } from "../icons";
import { useAppStore } from "../state";
import { useShallow } from "zustand/react/shallow";
import { api, type CatalogFile, type CatalogModel, type HipfireAvailableModel } from "../lib/api";
import { bitsClass } from "./Models";
import { useContextMenu, type MenuItem } from "../components/ContextMenu";
import { quantDescription } from "../lib/quant";
import { log } from "../lib/logger";

type SortBy = "downloads" | "likes" | "trending" | "modified";

const SORT_LABEL: Record<SortBy, string> = {
  downloads: "downloads",
  likes: "likes",
  trending: "trending",
  modified: "updated",
};

function fmtCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} B`;
}

export function CatalogScreen() {
  const engineKind = useAppStore((s) => s.settings.engine_kind);
  // hipfire has its own curated pull catalog (`hipfire list -r`), not a
  // HuggingFace GGUF search — render the dedicated panel instead. The llama
  // branch below (and everything it renders) is untouched by this check.
  if (engineKind === "hipfire") return <HipfireCatalogPanel />;
  return <LlamaCatalogScreen />;
}

function LlamaCatalogScreen() {
  const {
    settings,
    models,
    catalogResults,
    catalogSearching,
    catalogError,
    catalogSearched,
    catalogQuery,
    catalogSort,
    catalogFiles,
    catalogDownload,
    searchCatalog,
    setCatalogQuery,
    setCatalogSort,
    setHfToken,
    loadCatalogFiles,
    startCatalogDownload,
    cancelCatalogDownload,
    loadModelPath,
    reloadServer,
  } = useAppStore(
    useShallow((s) => ({
      settings: s.settings,
      models: s.models,
      catalogResults: s.catalogResults,
      catalogSearching: s.catalogSearching,
      catalogError: s.catalogError,
      catalogSearched: s.catalogSearched,
      catalogQuery: s.catalogQuery,
      catalogSort: s.catalogSort,
      catalogFiles: s.catalogFiles,
      catalogDownload: s.catalogDownload,
      searchCatalog: s.searchCatalog,
      setCatalogQuery: s.setCatalogQuery,
      setCatalogSort: s.setCatalogSort,
      setHfToken: s.setHfToken,
      loadCatalogFiles: s.loadCatalogFiles,
      startCatalogDownload: s.startCatalogDownload,
      cancelCatalogDownload: s.cancelCatalogDownload,
      loadModelPath: s.loadModelPath,
      reloadServer: s.reloadServer,
    })),
  );

  const [expanded, setExpanded] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [tokenDraft, setTokenDraft] = useState("");
  const hasToken = !!settings.hf_token;
  const openMenu = useContextMenu();

  // Run an initial search on first open so the page isn't blank.
  useEffect(() => {
    if (!catalogSearched && !catalogSearching) searchCatalog().catch(() => {});
  }, [catalogSearched, catalogSearching, searchCatalog]);

  // Map of already-downloaded files → local path, keyed "owner/filename", so a
  // catalog quant that's already on disk shows as "In library" with a Load.
  // Includes mmproj projectors (scanned into mmproj_files, not quants) so they
  // don't keep showing a "Get" button after download.
  const downloadedByKey = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of models?.tree ?? []) {
      for (const model of o.models) {
        for (const q of model.quants) m.set(`${o.owner}/${q.filename}`, q.path);
        for (const mm of model.mmproj_files) {
          const base = mm.split(/[\\/]/).pop() ?? mm;
          m.set(`${o.owner}/${base}`, mm);
        }
      }
    }
    return m;
  }, [models]);

  const onToggle = (repoId: string) => {
    setExpanded((cur) => {
      const next = cur === repoId ? null : repoId;
      if (next === repoId) loadCatalogFiles(repoId).catch(() => {});
      return next;
    });
  };

  const onLoad = async (path: string) => {
    loadModelPath(path);
    await reloadServer();
  };

  const downloading = catalogDownload != null;
  const dlPct =
    catalogDownload && catalogDownload.total > 0
      ? Math.min(100, (catalogDownload.downloaded / catalogDownload.total) * 100)
      : 0;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="crumb">Models / catalog</div>
          <h1>Model catalog</h1>
        </div>
        <div className="head-meta">
          <span className="badge ghost mono">{catalogResults.length} models</span>
          <button
            className="btn"
            onClick={() => {
              setTokenDraft(settings.hf_token ?? "");
              setShowToken((v) => !v);
            }}
            title="HuggingFace access token — faster downloads, higher rate limits, gated repos"
            style={hasToken ? { color: "var(--green)", borderColor: "var(--green)" } : undefined}
          >
            <I.Lock size={12} /> Token
            {hasToken && <span className="dot" style={{ background: "var(--green)" }} />}
          </button>
          <button
            className="btn"
            onClick={() => searchCatalog().catch(() => {})}
            disabled={catalogSearching}
            title="Re-run the search"
          >
            <I.Refresh
              size={12}
              style={{ animation: catalogSearching ? "spin 0.9s linear infinite" : "none" }}
            />{" "}
            Refresh
          </button>
        </div>
      </div>

      <div className="page-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {/* ── Search bar ── */}
        <div className="prof-toolbar">
          <form
            className="prof-search"
            style={{ flex: 1 }}
            onSubmit={(e) => {
              e.preventDefault();
              searchCatalog().catch(() => {});
            }}
          >
            <I.Search />
            <input
              placeholder="Search HuggingFace GGUF models (e.g. qwen3, llama 8b, gemma)…"
              value={catalogQuery}
              onChange={(e) => setCatalogQuery(e.target.value)}
            />
          </form>
          <div className="segmented">
            {(Object.keys(SORT_LABEL) as SortBy[]).map((s) => (
              <button
                key={s}
                className={catalogSort === s ? "on" : ""}
                onClick={() => setCatalogSort(s).catch(() => {})}
                disabled={catalogSearching}
                title={
                  catalogSearching
                    ? "Wait for the current search to finish"
                    : `Sort by ${SORT_LABEL[s]}`
                }
              >
                {SORT_LABEL[s]}
              </button>
            ))}
          </div>
        </div>

        {/* ── HuggingFace token ── */}
        {showToken && (
          <div className="panel">
            <div className="panel-head">
              <I.Lock size={14} /> HuggingFace access token
              <span className="meta">optional — accelerates downloads</span>
            </div>
            <div
              className="panel-body"
              style={{ display: "flex", flexDirection: "column", gap: 10 }}
            >
              <form
                style={{ display: "flex", gap: 8, alignItems: "center" }}
                onSubmit={(e) => {
                  e.preventDefault();
                  setHfToken(tokenDraft)
                    .then(() => {
                      setShowToken(false);
                      return searchCatalog();
                    })
                    .catch(() => {});
                }}
              >
                <input
                  className="input mono"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                  value={tokenDraft}
                  onChange={(e) => setTokenDraft(e.target.value)}
                  style={{ flex: 1 }}
                />
                <button
                  className="btn primary"
                  type="submit"
                  disabled={tokenDraft === (settings.hf_token ?? "")}
                >
                  <I.Check size={12} /> Save
                </button>
                <button
                  className="btn ghost"
                  type="button"
                  disabled={!hasToken && tokenDraft === ""}
                  onClick={() => {
                    setTokenDraft("");
                    setHfToken("").catch(() => {});
                  }}
                >
                  <I.Trash size={12} /> Clear
                </button>
              </form>
              <div style={{ fontSize: 11.5, color: "var(--muted)", lineHeight: 1.5 }}>
                <I.Info size={11} style={{ verticalAlign: -1, marginRight: 4 }} />A token lifts
                anonymous rate limits, enables the faster authenticated download path, and unlocks
                gated repos. Create a <strong>read</strong> token at{" "}
                <span className="mono" style={{ color: "var(--text-2)" }}>
                  huggingface.co/settings/tokens
                </span>
                . Stored locally in your settings and sent only to huggingface.co.
              </div>
            </div>
          </div>
        )}

        {/* ── Active download ── */}
        {downloading && catalogDownload && (
          <div
            className="panel"
            onContextMenu={(e) =>
              openMenu(e, [
                {
                  label: "Cancel download",
                  icon: "X",
                  danger: true,
                  onClick: () => cancelCatalogDownload().catch(() => {}),
                },
                "separator",
                {
                  label: "Open HuggingFace page",
                  icon: "ExternalLink",
                  onClick: () =>
                    api.openUrl(`https://huggingface.co/${catalogDownload.repoId}`).catch(() => {}),
                },
                {
                  label: "Copy repo id",
                  icon: "Copy",
                  onClick: () =>
                    navigator.clipboard?.writeText(catalogDownload.repoId).catch(() => {}),
                },
              ])
            }
          >
            <div className="panel-head">
              <I.Cloud size={14} /> Downloading{" "}
              <span className="mono" style={{ marginLeft: 4 }}>
                {catalogDownload.repoId}
              </span>
              <button
                className="btn ghost"
                style={{ marginLeft: "auto" }}
                onClick={() => cancelCatalogDownload().catch(() => {})}
              >
                <I.X size={11} /> Cancel
              </button>
            </div>
            <div
              className="panel-body"
              style={{ display: "flex", flexDirection: "column", gap: 8 }}
            >
              <div className="engine-track">
                <div className="engine-fill" style={{ width: `${Math.max(2, dlPct)}%` }} />
              </div>
              <div className="mono" style={{ fontSize: 11.5, color: "var(--muted)" }}>
                {catalogDownload.filename}
                {catalogDownload.parts > 1 &&
                  ` · part ${catalogDownload.part}/${catalogDownload.parts}`}{" "}
                · {fmtBytes(catalogDownload.downloaded)} /{" "}
                {catalogDownload.total > 0 ? fmtBytes(catalogDownload.total) : "?"} ·{" "}
                {dlPct.toFixed(0)}%
              </div>
            </div>
          </div>
        )}

        {catalogError && (
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
              <span style={{ flex: 1 }}>{catalogError}</span>
              <button
                className="btn ghost"
                style={{ color: "var(--text)" }}
                onClick={() => searchCatalog().catch(() => {})}
                disabled={catalogSearching}
                title="Retry the search"
              >
                <I.Refresh
                  size={12}
                  style={{ animation: catalogSearching ? "spin 0.9s linear infinite" : "none" }}
                />{" "}
                Retry
              </button>
            </div>
          </div>
        )}

        {/* ── Results ── */}
        {catalogSearching && catalogResults.length === 0 ? (
          <div className="catalog-empty">Searching HuggingFace…</div>
        ) : catalogResults.length === 0 ? (
          <div className="catalog-empty">
            {catalogSearched ? "No GGUF models match your search." : "Search to browse models."}
          </div>
        ) : (
          <div className="catalog-list">
            {catalogResults.map((m) => (
              <CatalogCard
                key={m.id}
                model={m}
                expanded={expanded === m.id}
                files={catalogFiles[m.id]}
                downloadedByKey={downloadedByKey}
                downloadBusy={downloading}
                activeFile={catalogDownload?.repoId === m.id ? catalogDownload.filename : null}
                onToggle={() => onToggle(m.id)}
                onDownload={(f) => startCatalogDownload(m.id, f).catch(() => {})}
                onLoad={(path) => onLoad(path).catch(() => {})}
                onSetModel={(path) => loadModelPath(path)}
                onCancel={() => cancelCatalogDownload().catch(() => {})}
              />
            ))}
          </div>
        )}

        <div className="engine-source mono">
          <I.Info size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
          from huggingface.co · GGUF library · downloads land in{" "}
          <span style={{ color: "var(--text-2)" }}>
            {settings.models_dir || "the app data folder"}
          </span>
        </div>
      </div>
    </>
  );
}

// ── hipfire pull catalog ─────────────────────────────────────────────────────
// hipfire's curated pull catalog (`hipfire list -r`'s "Available models:"
// section) — text search over tag+note, a Pull button per row driving the
// EXISTING hipfirePullSlice (one pull at a time; other rows disable while it
// runs), and a live log for the running pull. Never duplicates pull state —
// the slice (shared with Configure's HipfirePullPanel) is the single owner.
function stripDownloadedMarker(note: string): string {
  return note.replace(/\s*\[downloaded\]\s*/gi, " ").trim();
}

function HipfireCatalogPanel() {
  const { settings, hipfirePull, hipfirePullStart, hipfirePullCancel } = useAppStore(
    useShallow((s) => ({
      settings: s.settings,
      hipfirePull: s.hipfirePull,
      hipfirePullStart: s.hipfirePullStart,
      hipfirePullCancel: s.hipfirePullCancel,
    })),
  );

  const [catalog, setCatalog] = useState<HipfireAvailableModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  // Which row this panel itself requested a pull for — hipfirePull's store
  // state doesn't track a tag while running, so this is what lets the row UI
  // (Cancel + log vs. a disabled Pull) target the right row.
  const [pullingTag, setPullingTag] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await api.listHipfireAvailable(settings.hipfire_path);
      setCatalog(list);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setCatalog([]);
      setError(msg);
      log.warn("hipfire", "list_hipfire_available failed", { error: msg });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Re-fetches on mount, on a settled hipfire_path edit, and after every
    // successful pull (modelsVersion) so a freshly pulled tag's
    // "[downloaded]" marker shows up without a manual refresh click — same
    // trigger set as Models' hipfire panel and Configure's HipfirePullPanel.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.hipfire_path, hipfirePull.modelsVersion]);

  // Once the store-level pull finishes (success, failure, or cancel), this
  // panel no longer owns a specific row's pull.
  useEffect(() => {
    if (!hipfirePull.running) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPullingTag(null);
    }
  }, [hipfirePull.running]);

  const rows = useMemo(() => {
    if (!q) return catalog;
    const needle = q.toLowerCase();
    return catalog.filter(
      (m) => m.tag.toLowerCase().includes(needle) || m.note.toLowerCase().includes(needle),
    );
  }, [catalog, q]);

  const onPull = (tag: string) => {
    setPullingTag(tag);
    hipfirePullStart(settings.hipfire_path, tag).catch(() => {});
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="crumb">Models / hipfire catalog</div>
          <h1>Model catalog</h1>
        </div>
        <div className="head-meta">
          <span className="badge ghost mono">{catalog.length} models</span>
          <button
            className="btn"
            onClick={() => refresh().catch(() => {})}
            disabled={loading}
            title="Re-fetch hipfire's curated pull catalog"
          >
            <I.Refresh
              size={12}
              style={{ animation: loading ? "spin 0.9s linear infinite" : "none" }}
            />{" "}
            Refresh
          </button>
        </div>
      </div>

      <div className="page-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div className="prof-toolbar">
          <div className="prof-search" style={{ flex: 1 }}>
            <I.Search />
            <input
              placeholder="Filter by tag or description…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
        </div>

        {error && (
          <div className="panel">
            <div
              className="panel-body"
              style={{ fontSize: 12.5, color: "var(--red)", display: "flex", alignItems: "center", gap: 8 }}
            >
              <I.X size={12} style={{ flexShrink: 0 }} />
              <span style={{ flex: 1 }}>Couldn&apos;t list the catalog: {error}</span>
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

        {hipfirePull.running && pullingTag && (
          <div className="panel">
            <div className="panel-head">
              <I.Download size={14} /> Pulling{" "}
              <span className="mono" style={{ marginLeft: 4 }}>
                {pullingTag}
              </span>
              <button
                className="btn ghost"
                style={{ marginLeft: "auto" }}
                onClick={() => hipfirePullCancel().catch(() => {})}
              >
                <I.X size={11} /> Cancel
              </button>
            </div>
            <div className="panel-body">
              <div className="bench-progress">
                {hipfirePull.lines.length === 0
                  ? "starting…"
                  : hipfirePull.lines.slice(-40).join("\n")}
              </div>
            </div>
          </div>
        )}

        {loading && catalog.length === 0 ? (
          <div className="catalog-empty">Loading hipfire&apos;s pull catalog…</div>
        ) : rows.length === 0 ? (
          <div className="catalog-empty">
            {catalog.length === 0 ? "No catalog entries found." : "No models match your filter."}
          </div>
        ) : (
          <div className="panel">
            <div className="panel-body" style={{ padding: 0 }}>
              {rows.map((m) => {
                const isThisPulling = hipfirePull.running && pullingTag === m.tag;
                const pullDisabled = hipfirePull.running && !isThisPulling;
                return (
                  <div className="catalog-file" key={m.tag}>
                    <span className="catalog-file-name mono" title={m.tag}>
                      {m.tag}
                    </span>
                    {m.tag.endsWith("-draft") && (
                      <span
                        className="badge ghost"
                        style={{ fontSize: 9, padding: "0 5px" }}
                        title="Speculative-decoding draft — pairs with its target model"
                      >
                        draft
                      </span>
                    )}
                    <span
                      style={{
                        fontSize: 11,
                        color: "var(--muted)",
                        flex: 2,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={stripDownloadedMarker(m.note)}
                    >
                      {stripDownloadedMarker(m.note)}
                    </span>
                    <span className="catalog-file-size mono">{m.size}</span>
                    {m.downloaded ? (
                      <span className="badge ghost" style={{ fontSize: 10 }}>
                        <I.Check size={10} style={{ verticalAlign: -1, marginRight: 2 }} />
                        downloaded
                      </span>
                    ) : isThisPulling ? (
                      <span className="badge accent" style={{ fontSize: 10 }}>
                        <span className="dot" /> pulling
                      </span>
                    ) : (
                      <button
                        className="btn primary"
                        onClick={() => onPull(m.tag)}
                        disabled={pullDisabled}
                        title={pullDisabled ? "Another pull is running" : `Pull ${m.tag}`}
                      >
                        <I.Download size={11} /> Pull
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="engine-source mono">
          <I.Info size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
          from hipfire&apos;s curated pull catalog · downloads land in hipfire&apos;s local store
        </div>
      </div>
    </>
  );
}

function CatalogCard({
  model,
  expanded,
  files,
  downloadedByKey,
  downloadBusy,
  activeFile,
  onToggle,
  onDownload,
  onLoad,
  onSetModel,
  onCancel,
}: Readonly<{
  model: CatalogModel;
  expanded: boolean;
  files: CatalogFile[] | "loading" | "error" | undefined;
  downloadedByKey: Map<string, string>;
  downloadBusy: boolean;
  activeFile: string | null;
  onToggle: () => void;
  onDownload: (f: CatalogFile) => void;
  onLoad: (path: string) => void;
  onSetModel: (path: string) => void;
  onCancel: () => void;
}>) {
  const openMenu = useContextMenu();
  const hfUrl = `https://huggingface.co/${model.id}`;

  const cardMenuItems = (): MenuItem[] => [
    { label: expanded ? "Hide files" : "Show files", icon: "ChevR", onClick: onToggle },
    "separator",
    {
      label: "Open HuggingFace page",
      icon: "ExternalLink",
      onClick: () => api.openUrl(hfUrl).catch(() => {}),
    },
    {
      label: "Copy repo id",
      icon: "Copy",
      onClick: () => navigator.clipboard?.writeText(model.id).catch(() => {}),
    },
    {
      label: "Copy page URL",
      icon: "Copy",
      onClick: () => navigator.clipboard?.writeText(hfUrl).catch(() => {}),
    },
  ];

  const fileMenuItems = (
    f: CatalogFile,
    localPath: string | undefined,
    isActive: boolean,
  ): MenuItem[] => {
    const items: MenuItem[] = [];
    if (isActive) {
      items.push({ label: "Cancel download", icon: "X", danger: true, onClick: onCancel });
    } else if (localPath) {
      items.push(
        {
          label: "Load & restart server",
          icon: "Play",
          onClick: () => onLoad(localPath),
        },
        {
          label: "Set as model (no restart)",
          icon: "Check",
          onClick: () => onSetModel(localPath),
        },
        {
          label: "Reveal in Explorer",
          icon: "Folder",
          onClick: () => api.revealInExplorer(localPath).catch(() => {}),
        },
      );
    } else {
      items.push({
        label: "Download",
        icon: "Download",
        disabled: downloadBusy,
        onClick: () => onDownload(f),
      });
    }
    items.push(
      "separator",
      {
        label: "Open file on HuggingFace",
        icon: "ExternalLink",
        disabled: f.url_paths.length === 0,
        onClick: () => api.openUrl(`${hfUrl}/blob/main/${f.url_paths[0]}`).catch(() => {}),
      },
      {
        label: "Copy download URL",
        icon: "Copy",
        disabled: f.url_paths.length === 0,
        onClick: () =>
          navigator.clipboard?.writeText(`${hfUrl}/resolve/main/${f.url_paths[0]}`).catch(() => {}),
      },
      {
        label: "Copy filename",
        icon: "Copy",
        onClick: () => navigator.clipboard?.writeText(f.filename).catch(() => {}),
      },
    );
    return items;
  };

  return (
    <div className={"catalog-card" + (expanded ? " active" : "")}>
      <button
        className="catalog-card-head"
        onClick={onToggle}
        onContextMenu={(e) => openMenu(e, cardMenuItems())}
      >
        <I.Cloud size={14} className="catalog-card-icon" />
        <span className="catalog-id mono" title={model.id}>
          <span className="catalog-owner">{model.owner}/</span>
          {model.name}
        </span>
        {model.params && (
          <span className="badge ghost mono" style={{ fontSize: 9.5, padding: "1px 5px" }}>
            {model.params}
          </span>
        )}
        {model.gated && (
          <span
            className="badge"
            style={{ fontSize: 9.5, padding: "1px 5px", color: "var(--yellow)" }}
            title={`Gated (${model.gated_kind ?? "terms required"}) — accept on huggingface.co first`}
          >
            <I.Lock size={9} style={{ verticalAlign: -1, marginRight: 2 }} />
            gated
          </span>
        )}
        <span className="catalog-stats">
          <span title="downloads (last 30d)">
            <I.Download size={11} /> {fmtCount(model.downloads)}
          </span>
          <span title="likes">
            <I.Star size={11} /> {fmtCount(model.likes)}
          </span>
          {model.gguf_count > 0 && (
            <span className="mono" title="GGUF files in this repo">
              {model.gguf_count} files
            </span>
          )}
        </span>
        <I.ChevR
          size={13}
          className="catalog-chev"
          style={{ transform: expanded ? "rotate(90deg)" : undefined }}
        />
      </button>

      {expanded && (
        <div className="catalog-files">
          {files === "loading" || files === undefined ? (
            <div className="catalog-file-msg">Loading quants…</div>
          ) : files === "error" ? (
            <div className="catalog-file-msg" style={{ color: "var(--red)" }}>
              Couldn&apos;t list files for this repo.
            </div>
          ) : files.length === 0 ? (
            <div className="catalog-file-msg">No downloadable GGUF quants found.</div>
          ) : (
            files.map((f) => {
              const localPath = downloadedByKey.get(`${model.owner}/${f.filename}`);
              const isActive = activeFile === f.filename;
              return (
                <div
                  className="catalog-file"
                  key={f.filename}
                  onContextMenu={(e) => openMenu(e, fileMenuItems(f, localPath, isActive))}
                >
                  <span
                    className={"quant-tag mono " + bitsClass(f.bits)}
                    title={quantDescription(f.tag)}
                  >
                    {f.tag}
                  </span>
                  <span className="catalog-file-name mono" title={f.filename}>
                    {f.filename}
                  </span>
                  {f.is_mmproj && (
                    <span
                      className="badge ghost"
                      style={{ fontSize: 9, padding: "0 5px", color: "var(--cyan)" }}
                      title="Multimodal projector (vision)"
                    >
                      mmproj
                    </span>
                  )}
                  {f.is_split && (
                    <span
                      className="badge ghost"
                      style={{ fontSize: 9, padding: "0 5px" }}
                      title={`Split across ${f.n_parts} shards — all are downloaded together`}
                    >
                      ×{f.n_parts}
                    </span>
                  )}
                  <span className="catalog-file-size mono">{fmtBytes(f.size)}</span>
                  {localPath ? (
                    <button
                      className="btn ghost"
                      onClick={() => onLoad(localPath)}
                      title="Already downloaded — load it"
                    >
                      <I.Check size={11} /> In library
                    </button>
                  ) : isActive ? (
                    <span className="badge accent" style={{ fontSize: 10 }}>
                      <span className="dot" /> downloading
                    </span>
                  ) : (
                    <button
                      className="btn primary"
                      onClick={() => onDownload(f)}
                      disabled={downloadBusy}
                      title={
                        downloadBusy ? "Another download is running" : "Download into the library"
                      }
                    >
                      <I.Download size={11} /> Get
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
