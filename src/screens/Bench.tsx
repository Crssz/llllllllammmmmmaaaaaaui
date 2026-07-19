import { useEffect, useState } from "react";
import { I } from "../icons";
import {
  api,
  type BenchRequest,
  type BenchRow,
  type BenchRun,
  type HipfireBenchSummary,
  type HipfireLocalModel,
} from "../lib/api";
import { useAppStore, type FlagValues } from "../state";
import { useShallow } from "zustand/react/shallow";
import { useContextMenu, type MenuItem } from "../components/ContextMenu";
import { useTextPrompt } from "../components/TextPromptDialog";
import { useConfirm } from "../components/ConfirmDialog";
import { log } from "../lib/logger";

// llama-bench shares a subset of llama-server's flags, so the benchmark can
// inherit them from the live Configure config and measure the model the way the
// user actually serves it. The KV-cache types matter most here: llama-bench
// defaults them to f16, so without inheriting -ctk/-ctv the benchmark would
// silently report throughput for a different cache than the server runs.
// Bench-only knobs (-p/-n/-r/label) have no server equivalent and are left out.
// Used both to seed the form on mount and by the "From config" button.
function benchFromConfig(f: FlagValues) {
  const str = (v: string | number | boolean | undefined, fallback = "") =>
    v === undefined || v === null || v === "" ? fallback : String(v);
  return {
    model: str(f.model),
    ngl: str(f.ngl, "999"),
    threads: str(f.threads),
    batch: str(f.batch, "2048"),
    ubatch: str(f.ubatch),
    ctk: str(f.ctk),
    ctv: str(f.ctv),
    fa: f.fa ? "on" : "auto",
  };
}

function basename(p: string): string {
  if (!p) return "";
  const sep = p.includes("\\") ? "\\" : "/";
  return p.split(sep).pop() || p;
}

// Reconstruct llama-bench's human test label from n_prompt/n_gen/n_depth — the
// JSON has no "test" column (markdown/csv only), so we mirror its printer.
function rowLabel(r: BenchRow): string {
  let base: string;
  if (r.n_prompt > 0 && r.n_gen === 0) base = `pp${r.n_prompt}`;
  else if (r.n_gen > 0 && r.n_prompt === 0) base = `tg${r.n_gen}`;
  else base = `pp${r.n_prompt}+tg${r.n_gen}`;
  return r.n_depth > 0 ? `${base} @ d${r.n_depth}` : base;
}

function faLabel(v: number): string {
  return v === 0 ? "off" : v === 1 ? "on" : "auto";
}

function nglLabel(v: number): string {
  return v < 0 ? "all" : String(v);
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

function bestTs(rows: BenchRow[]): number {
  return rows.reduce((mx, r) => Math.max(mx, r.avg_ts), 0);
}

function kvLabel(r: BenchRow): string {
  return r.type_k && r.type_v ? `${r.type_k}/${r.type_v}` : "—";
}

// Clipboard exports for a saved run, mirroring the ResultsTable columns.
function runToMarkdown(r: BenchRun): string {
  const lines = r.rows.map(
    (row) =>
      `| ${rowLabel(row)} | ${nglLabel(row.n_gpu_layers)} | ${row.n_batch || "—"} | ` +
      `${faLabel(row.flash_attn)} | ${kvLabel(row)} | ${row.avg_ts.toFixed(2)} | ` +
      `${row.stddev_ts > 0 ? row.stddev_ts.toFixed(2) : "—"} |`,
  );
  return [
    `### ${r.label} — ${basename(r.model_path)}`,
    "",
    "| test | ngl | batch | fa | kv | t/s | ± stddev |",
    "| --- | ---: | ---: | --- | --- | ---: | ---: |",
    ...lines,
  ].join("\n");
}

function runToCsv(r: BenchRun): string {
  const lines = r.rows.map((row) =>
    [
      rowLabel(row),
      nglLabel(row.n_gpu_layers),
      row.n_batch,
      faLabel(row.flash_attn),
      kvLabel(row),
      row.avg_ts,
      row.stddev_ts,
      row.avg_ns,
    ].join(","),
  );
  return ["test,ngl,batch,fa,kv,avg_ts,stddev_ts,avg_ns", ...lines].join("\n");
}

// A numeric/text field that accepts a single value or a comma-separated sweep.
function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
  width,
}: Readonly<{
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
  width?: number;
}>) {
  return (
    <div className="bench-field" style={width ? { maxWidth: width } : undefined}>
      <label>
        <span>{label}</span>
        {hint && <span className="hint">{hint}</span>}
      </label>
      <input
        className="input"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
    </div>
  );
}

function ResultsTable({ rows }: Readonly<{ rows: BenchRow[] }>) {
  const top = bestTs(rows);
  return (
    <table className="bench-table">
      <thead>
        <tr>
          <th>test</th>
          <th className="num" title="GPU layers">
            ngl
          </th>
          <th className="num">batch</th>
          <th title="Flash attention">fa</th>
          <th title="KV cache type">kv</th>
          <th className="num" title="Tokens per second">
            t/s
          </th>
          <th className="num">± stddev</th>
          <th className="num">latency</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const isBest = r.avg_ts === top && top > 0;
          const ms = r.avg_ns > 0 ? r.avg_ns / 1e6 : 0;
          return (
            <tr key={i} className={isBest ? "best" : undefined}>
              <td>{rowLabel(r)}</td>
              <td className="num">{nglLabel(r.n_gpu_layers)}</td>
              <td className="num">{r.n_batch || "—"}</td>
              <td>{faLabel(r.flash_attn)}</td>
              <td>{r.type_k && r.type_v ? `${r.type_k}/${r.type_v}` : "—"}</td>
              <td className="num ts">{r.avg_ts.toFixed(1)}</td>
              <td className="num">{r.stddev_ts > 0 ? `± ${r.stddev_ts.toFixed(1)}` : "—"}</td>
              <td className="num">{ms > 0 ? `${ms.toFixed(1)} ms` : "—"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function CompareBars({ rows }: Readonly<{ rows: BenchRow[] }>) {
  const top = bestTs(rows);
  if (top <= 0) return null;
  return (
    <div className="bench-bars">
      {rows.map((r, i) => {
        const pct = (r.avg_ts / top) * 100;
        const isBest = r.avg_ts === top;
        return (
          <div key={i} className={"bench-bar" + (isBest ? " best" : "")}>
            <span className="blabel" title={rowLabel(r)}>
              {rowLabel(r)}
            </span>
            <div className="btrack">
              <div className="bfill" style={{ width: `${Math.max(2, pct)}%` }} />
            </div>
            <span className="bval">{r.avg_ts.toFixed(1)} t/s</span>
          </div>
        );
      })}
    </div>
  );
}

export function BenchScreen() {
  const engineKind = useAppStore((s) => s.settings.engine_kind);
  // hipfire has its own real bench tool (`hipfire bench`) — render the
  // dedicated panel instead of the old "no equivalent bench tool" banner.
  // The llama branch below (and everything it renders) is untouched by this
  // check.
  if (engineKind === "hipfire") return <HipfireBenchScreen />;
  return <LlamaBenchScreen />;
}

function LlamaBenchScreen() {
  const {
    buildDir,
    benchBinary,
    bench,
    benchRuns,
    benchViewingId,
    benchStart,
    benchCancel,
    benchSelectRun,
    benchDeleteRun,
    benchRenameRun,
  } = useAppStore(
    useShallow((s) => ({
      buildDir: s.settings.build_dir,
      benchBinary: s.build?.binaries?.find((b) => b.name === "llama-bench") ?? null,
      bench: s.bench,
      benchRuns: s.benchRuns,
      benchViewingId: s.benchViewingId,
      benchStart: s.benchStart,
      benchCancel: s.benchCancel,
      benchSelectRun: s.benchSelectRun,
      benchDeleteRun: s.benchDeleteRun,
      benchRenameRun: s.benchRenameRun,
    })),
  );

  const openMenu = useContextMenu();
  const { promptElement, openPrompt } = useTextPrompt();
  const { confirmElement, confirm } = useConfirm();

  // Fire-and-forget clipboard write with a house toast for success/failure —
  // silent copies leave the user guessing whether the click did anything.
  const copyToClipboard = (text: string, what: string) => {
    navigator.clipboard
      ?.writeText(text)
      .then(() => log.notify("info", "bench", `Copied ${what}`))
      .catch(() => log.notify("error", "bench", `Copy failed: ${what}`));
  };

  const requestDeleteRun = async (r: BenchRun) => {
    if (
      await confirm({
        title: `Delete run "${r.label}"?`,
        confirmLabel: "Delete",
        danger: true,
      })
    ) {
      benchDeleteRun(r.id);
    }
  };

  const runMenuItems = (r: BenchRun): MenuItem[] => [
    { label: "View results", icon: "History", onClick: () => benchSelectRun(r.id) },
    {
      label: "Rename…",
      icon: "Pencil",
      onClick: () =>
        openPrompt({
          title: "Rename benchmark run",
          initial: r.label,
          onSubmit: (v) => benchRenameRun(r.id, v),
        }),
    },
    {
      label: "Copy as",
      icon: "Copy",
      submenu: [
        {
          label: "Markdown table",
          onClick: () => copyToClipboard(runToMarkdown(r), "Markdown"),
        },
        {
          label: "CSV",
          onClick: () => copyToClipboard(runToCsv(r), "CSV"),
        },
        {
          label: "JSON",
          onClick: () => copyToClipboard(JSON.stringify(r, null, 2), "JSON"),
        },
      ],
    },
    {
      label: "Copy model path",
      icon: "Copy",
      disabled: !r.model_path,
      onClick: () => copyToClipboard(r.model_path, "model path"),
    },
    "separator",
    {
      label: "Delete run…",
      icon: "Trash",
      danger: true,
      onClick: () => {
        requestDeleteRun(r);
      },
    },
  ];

  // Seed the form from the current server config so the benchmark reflects how
  // the user actually runs the model. These are local copies — running a
  // benchmark never mutates the Configure flags.
  const [seed] = useState(() => benchFromConfig(useAppStore.getState().flags));
  const [model, setModel] = useState(seed.model);
  const [nPrompt, setNPrompt] = useState("512");
  const [nGen, setNGen] = useState("128");
  const [ngl, setNgl] = useState(seed.ngl);
  const [threads, setThreads] = useState(seed.threads);
  const [batch, setBatch] = useState(seed.batch);
  const [ubatch, setUbatch] = useState(seed.ubatch);
  const [ctk, setCtk] = useState(seed.ctk);
  const [ctv, setCtv] = useState(seed.ctv);
  const [fa, setFa] = useState(seed.fa);
  const [reps, setReps] = useState("3");
  const [label, setLabel] = useState("");

  const benchMissing = Boolean(buildDir) && benchBinary != null && !benchBinary.ok;
  const canRun = !bench.running && Boolean(model) && Boolean(buildDir) && !benchMissing;
  // First missing prerequisite, surfaced as the disabled button's tooltip so
  // the user isn't left guessing why "Run benchmark" won't click.
  const runDisabledReason = bench.running
    ? "A benchmark is already running"
    : !buildDir
      ? "Pick a llama.cpp build directory first"
      : benchMissing
        ? "llama-bench isn't in this build"
        : !model
          ? "Pick a model first"
          : null;

  const onRun = () => {
    if (!buildDir) return;
    const req: BenchRequest = {
      model,
      n_prompt: nPrompt,
      n_gen: nGen,
      n_gpu_layers: ngl,
      threads,
      batch,
      ubatch,
      cache_type_k: ctk,
      cache_type_v: ctv,
      flash_attn: fa,
      reps: Number(reps) || 0,
      extra: [],
    };
    benchStart(buildDir, req, label).catch(() => {});
  };

  const onBrowse = async () => {
    const picked = await api.pickFile();
    if (picked) {
      setModel(picked);
      if (!label) setLabel(basename(picked));
    }
  };

  const syncFromConfig = () => {
    const c = benchFromConfig(useAppStore.getState().flags);
    if (c.model) setModel(c.model); // keep a hand-picked model if config has none
    setNgl(c.ngl);
    setThreads(c.threads);
    setBatch(c.batch);
    setUbatch(c.ubatch);
    setCtk(c.ctk);
    setCtv(c.ctv);
    setFa(c.fa);
  };

  const viewingRun = benchViewingId ? benchRuns.find((r) => r.id === benchViewingId) : null;
  const rows = viewingRun ? viewingRun.rows : bench.results;
  const sourceLabel = viewingRun
    ? `${viewingRun.label} · ${relTime(viewingRun.created_at)}`
    : "latest run";

  return (
    <>
      <div className="page-head">
        <div>
          <div className="crumb">Benchmark / llama-bench</div>
          <h1>Throughput benchmark</h1>
        </div>
        <div className="head-meta">
          {buildDir && benchBinary?.ok && (
            <span className="badge ghost mono" title="llama-bench detected in the build directory">
              <I.Check size={11} /> llama-bench {benchBinary.size}
            </span>
          )}
          {bench.running ? (
            <button className="btn" onClick={() => benchCancel().catch(() => {})}>
              <I.Stop /> Cancel
            </button>
          ) : (
            <button
              className="btn primary"
              onClick={onRun}
              disabled={!canRun}
              title={runDisabledReason ?? "Run benchmark"}
            >
              <I.Bolt /> Run benchmark
            </button>
          )}
        </div>
      </div>

      <div className="page-body" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {!buildDir && (
          <div className="panel">
            <div className="panel-body" style={{ fontSize: 12.5, color: "var(--muted)" }}>
              Pick a llama.cpp build directory on <strong>Configure → Binary</strong> first — the
              benchmark runs the <span className="mono">llama-bench</span> executable from that
              build.
            </div>
          </div>
        )}
        {benchMissing && (
          <div className="panel">
            <div className="panel-body" style={{ fontSize: 12.5, color: "var(--yellow)" }}>
              <I.Info size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
              llama-bench isn&apos;t in this build. Build it with{" "}
              <span className="mono">cmake --build . --target llama-bench</span>.
            </div>
          </div>
        )}
        {bench.error && !bench.running && (
          <div className="panel">
            <div className="panel-body" style={{ fontSize: 12.5, color: "var(--red)" }}>
              <I.X size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
              {bench.error}
            </div>
          </div>
        )}

        {/* ── Config ── */}
        <div className="panel">
          <div className="panel-head">
            <I.Sliders size={14} /> Configuration
            <span className="meta" style={{ marginLeft: "auto" }}>
              <button
                className="btn ghost"
                onClick={syncFromConfig}
                title="Copy model, GPU layers, threads, batch, micro-batch, KV-cache types & flash-attn from the Configure tab"
              >
                <I.Refresh size={11} /> From config
              </button>
            </span>
          </div>
          <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="bench-field bench-model">
              <label>
                <span>Model</span>
                {model && <span className="hint mono">{basename(model)}</span>}
              </label>
              <div className="bench-model-row">
                <input
                  className="input"
                  value={model}
                  placeholder="path to a .gguf file"
                  onChange={(e) => setModel(e.target.value)}
                  spellCheck={false}
                />
                <button className="btn" onClick={() => onBrowse().catch(() => {})}>
                  <I.Folder size={12} /> Browse
                </button>
              </div>
            </div>

            <div className="bench-form">
              <Field
                label="Prompt tokens"
                hint="-p"
                value={nPrompt}
                onChange={setNPrompt}
                placeholder="512"
              />
              <Field
                label="Gen tokens"
                hint="-n"
                value={nGen}
                onChange={setNGen}
                placeholder="128"
              />
              <Field
                label="GPU layers"
                hint="-ngl"
                value={ngl}
                onChange={setNgl}
                placeholder="999"
              />
              <Field
                label="Threads"
                hint="-t"
                value={threads}
                onChange={setThreads}
                placeholder="auto"
              />
              <Field label="Batch" hint="-b" value={batch} onChange={setBatch} placeholder="2048" />
              <Field
                label="Micro-batch"
                hint="-ub"
                value={ubatch}
                onChange={setUbatch}
                placeholder="512"
              />
              <Field label="K cache" hint="-ctk" value={ctk} onChange={setCtk} placeholder="f16" />
              <Field label="V cache" hint="-ctv" value={ctv} onChange={setCtv} placeholder="f16" />
              <div className="bench-field">
                <label>
                  <span>Flash attn</span>
                  <span className="hint">-fa</span>
                </label>
                <select className="select" value={fa} onChange={(e) => setFa(e.target.value)}>
                  <option value="auto">auto</option>
                  <option value="on">on</option>
                  <option value="off">off</option>
                </select>
              </div>
              <Field
                label="Repetitions"
                hint="-r"
                value={reps}
                onChange={setReps}
                placeholder="3"
              />
              <Field
                label="Save as"
                hint="label"
                value={label}
                onChange={setLabel}
                placeholder="(auto)"
              />
            </div>

            <div style={{ fontSize: 11, color: "var(--subtle)", fontStyle: "italic" }}>
              Comma-separate any numeric field to sweep configs in one run — e.g.{" "}
              <span className="mono">-ngl 0,20,99</span> or{" "}
              <span className="mono">-p 256,512,1024</span>.
            </div>
          </div>
        </div>

        {/* ── Live progress ── */}
        {bench.running && (
          <div className="panel">
            <div className="panel-head">
              <span
                className="pulse"
                style={{ background: "var(--yellow)", boxShadow: "0 0 8px var(--yellow)" }}
              />
              Running llama-bench…
              <span className="meta" style={{ marginLeft: "auto" }}>
                {basename(model)}
              </span>
            </div>
            <div className="panel-body">
              <div className="bench-progress">
                {bench.progress.length === 0 ? "warming up…" : bench.progress.slice(-40).join("\n")}
              </div>
            </div>
          </div>
        )}

        {/* ── Results ── */}
        {rows && rows.length > 0 && (
          <div className="panel">
            <div className="panel-head">
              <I.Bolt size={14} /> Results
              <span className="meta" style={{ marginLeft: "auto" }}>
                {sourceLabel}
                {viewingRun && (
                  <button
                    className="btn ghost"
                    style={{ marginLeft: 8 }}
                    onClick={() => benchSelectRun(null)}
                  >
                    Back to latest
                  </button>
                )}
              </span>
            </div>
            <div
              className="panel-body"
              style={{ display: "flex", flexDirection: "column", gap: 18 }}
            >
              <CompareBars rows={rows} />
              <div style={{ height: 1, background: "var(--border)" }} />
              <div style={{ overflowX: "auto" }}>
                <ResultsTable rows={rows} />
              </div>
              <div style={{ fontSize: 11, color: "var(--subtle)", fontStyle: "italic" }}>
                pp = prompt processing · tg = token generation · d = context depth
              </div>
            </div>
          </div>
        )}
        {!bench.running && (!rows || rows.length === 0) && buildDir && !benchMissing && (
          <div className="panel">
            <div className="panel-body" style={{ fontSize: 12.5, color: "var(--muted)" }}>
              No results yet. Set your parameters above and hit <strong>Run benchmark</strong> to
              measure prompt-processing and generation throughput.
            </div>
          </div>
        )}

        {/* ── History ── */}
        {benchRuns.length > 0 && (
          <div className="panel">
            <div className="panel-head">
              <I.History size={14} /> History
              <span className="meta" style={{ marginLeft: "auto" }}>
                {benchRuns.length} run{benchRuns.length === 1 ? "" : "s"}
              </span>
            </div>
            <div className="panel-body">
              <div className="bench-runs">
                {benchRuns.map((r) => {
                  const top = bestTs(r.rows);
                  return (
                    <button
                      key={r.id}
                      className={"bench-run" + (benchViewingId === r.id ? " active" : "")}
                      onClick={() => benchSelectRun(r.id)}
                      onContextMenu={(e) => openMenu(e, runMenuItems(r))}
                    >
                      <I.Bolt size={13} style={{ color: "var(--muted)", flexShrink: 0 }} />
                      <span className="rname">
                        <span className="rtitle">{r.label}</span>
                        <span className="rsub">
                          {basename(r.model_path)} · {r.rows.length} row
                          {r.rows.length === 1 ? "" : "s"} · {relTime(r.created_at)}
                        </span>
                      </span>
                      <span className="badge ghost mono">{top.toFixed(1)} t/s</span>
                      <span
                        className="iconbtn rdel"
                        role="button"
                        tabIndex={0}
                        title="Delete run"
                        onClick={(e) => {
                          e.stopPropagation();
                          requestDeleteRun(r);
                        }}
                      >
                        <I.X size={12} />
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
      {promptElement}
      {confirmElement}
    </>
  );
}

// ── hipfire bench ────────────────────────────────────────────────────────────
// `hipfire bench <tag> --runs <N>` — a real throughput benchmark (2026-07-19
// live capture, fact 1), unlike the old banner claimed. Driven by
// hipfireBenchSlice (store-lifted, mirrors hipfirePullSlice) so a run
// survives switching tabs. Results are session-local: the persisted bench-run
// history (bench_runs.json / BenchRun) is llama-bench's JSON row shape
// (model_filename, n_prompt/n_gen, avg_ts…) and has no clean way to carry a
// hipfire summary's very different shape (header + prefill sweep + named
// summary rows) without either forcing a lossy conversion or growing an
// engine-tagged union — see the docs commit for the full rationale.
function HipfireResultCard({
  tag,
  summary,
  output,
}: Readonly<{ tag: string; summary: HipfireBenchSummary | null; output: string }>) {
  const [showRaw, setShowRaw] = useState(false);
  const headerLine = summary
    ? [
        summary.header.model,
        summary.header.arch,
        summary.header.gpu,
        summary.header.kv_cache ? `kv=${summary.header.kv_cache}` : null,
        summary.header.vram,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  return (
    <div className="panel">
      <div className="panel-head">
        <I.Bolt size={14} /> Results
        <span className="meta" style={{ marginLeft: "auto" }}>
          {tag}
        </span>
      </div>
      <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {summary ? (
          <>
            {headerLine && (
              <div className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>
                {headerLine}
              </div>
            )}
            {summary.prefill.length > 0 && (
              <div>
                <div style={{ fontSize: 11, color: "var(--subtle)", marginBottom: 6 }}>
                  Prefill sweep
                </div>
                <table className="bench-table">
                  <thead>
                    <tr>
                      <th>test</th>
                      <th className="num">tok/s</th>
                      <th className="num">± stddev</th>
                      <th className="num">ms</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.prefill.map((r) => (
                      <tr key={r.label}>
                        <td>{r.label}</td>
                        <td className="num ts">{r.mean.toFixed(1)}</td>
                        <td className="num">{r.stdev > 0 ? `± ${r.stdev.toFixed(1)}` : "—"}</td>
                        <td className="num">{r.ms != null ? `${r.ms.toFixed(1)} ms` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {summary.summary.length > 0 && (
              <div>
                <div style={{ fontSize: 11, color: "var(--subtle)", marginBottom: 6 }}>
                  Decode / TTFT / Wall
                </div>
                <table className="bench-table">
                  <thead>
                    <tr>
                      <th>metric</th>
                      <th className="num">mean</th>
                      <th className="num">min</th>
                      <th className="num">max</th>
                      <th className="num">± stddev</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.summary.map((r) => (
                      <tr key={r.label}>
                        <td>{r.label}</td>
                        <td className="num ts">{r.mean.toFixed(1)}</td>
                        <td className="num">{r.min.toFixed(1)}</td>
                        <td className="num">{r.max.toFixed(1)}</td>
                        <td className="num">{r.stdev > 0 ? `± ${r.stdev.toFixed(1)}` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {summary.decode_ms_per_tok != null && (
              <div className="mono" style={{ fontSize: 11.5, color: "var(--muted)" }}>
                Decode ms/tok: {summary.decode_ms_per_tok.toFixed(2)}
              </div>
            )}
          </>
        ) : (
          <div style={{ fontSize: 12.5, color: "var(--muted)" }}>
            <I.Info size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
            Couldn&apos;t parse a structured summary from the output — see the raw output below.
          </div>
        )}
        <div>
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
              {output || "(empty)"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function HipfireBenchScreen() {
  const { settings, hipfireBench, hipfireBenchStart, hipfireBenchCancel, hipfireModelsVersion } =
    useAppStore(
      useShallow((s) => ({
        settings: s.settings,
        hipfireBench: s.hipfireBench,
        hipfireBenchStart: s.hipfireBenchStart,
        hipfireBenchCancel: s.hipfireBenchCancel,
        hipfireModelsVersion: s.hipfirePull.modelsVersion,
      })),
    );

  const [models, setModels] = useState<HipfireLocalModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [tag, setTag] = useState("");
  const [runs, setRuns] = useState("3");

  const refreshModels = async () => {
    setModelsLoading(true);
    setModelsError(null);
    try {
      const list = await api.listHipfireModels(settings.hipfire_path);
      setModels(list);
      // Default selection excludes "-draft" companion tags (they aren't meant
      // to be served/benched on their own) but the dropdown still lists them
      // so the user can pick one explicitly if they want to.
      setTag((cur) => {
        if (cur && list.some((m) => m.tag === cur)) return cur;
        return list.find((m) => !m.tag.endsWith("-draft"))?.tag ?? list[0]?.tag ?? "";
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setModels([]);
      setModelsError(msg);
      log.warn("hipfire", "list_hipfire_models failed", { error: msg });
    } finally {
      setModelsLoading(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refreshModels().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.hipfire_path, hipfireModelsVersion]);

  const runsN = Math.max(1, Number(runs) || 1);
  const canRun = !hipfireBench.running && Boolean(tag);
  const runDisabledReason = hipfireBench.running
    ? "A benchmark is already running"
    : !tag
      ? "Pick a local model tag first"
      : null;

  const onRun = () => {
    if (!tag) return;
    hipfireBenchStart(settings.hipfire_path, tag, runsN).catch(() => {});
  };

  const result = hipfireBench.result;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="crumb">Benchmark / hipfire bench</div>
          <h1>Throughput benchmark</h1>
        </div>
        <div className="head-meta">
          {hipfireBench.running ? (
            <button className="btn" onClick={() => hipfireBenchCancel().catch(() => {})}>
              <I.Stop /> Cancel
            </button>
          ) : (
            <button
              className="btn primary"
              onClick={onRun}
              disabled={!canRun}
              title={runDisabledReason ?? "Run benchmark"}
            >
              <I.Bolt /> Run benchmark
            </button>
          )}
        </div>
      </div>

      <div className="page-body" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {modelsError && (
          <div className="panel">
            <div
              className="panel-body"
              style={{ fontSize: 12.5, color: "var(--red)", display: "flex", alignItems: "center", gap: 8 }}
            >
              <I.X size={12} style={{ flexShrink: 0 }} />
              <span style={{ flex: 1 }}>Couldn&apos;t list local models: {modelsError}</span>
              <button
                className="btn ghost"
                style={{ color: "var(--text)" }}
                onClick={() => refreshModels().catch(() => {})}
              >
                <I.Refresh size={12} /> Retry
              </button>
            </div>
          </div>
        )}
        {!modelsError && models.length === 0 && !modelsLoading && (
          <div className="panel">
            <div className="panel-body" style={{ fontSize: 12.5, color: "var(--muted)" }}>
              <I.Info size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
              No local hipfire models yet — pull one on <strong>Catalog</strong> first.
            </div>
          </div>
        )}
        {hipfireBench.result && !hipfireBench.running && !hipfireBench.result.ok && (
          <div className="panel">
            <div className="panel-body" style={{ fontSize: 12.5, color: "var(--red)" }}>
              <I.X size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
              {hipfireBench.result.cancelled ? "Cancelled." : hipfireBench.result.error}
            </div>
          </div>
        )}

        <div className="panel">
          <div className="panel-head">
            <I.Sliders size={14} /> Configuration
            <span className="meta" style={{ marginLeft: "auto" }}>
              <button
                className="btn ghost"
                onClick={() => refreshModels().catch(() => {})}
                disabled={modelsLoading}
                title="Refresh local model list"
              >
                <I.Refresh
                  size={11}
                  style={{ animation: modelsLoading ? "spin 0.9s linear infinite" : "none" }}
                />
              </button>
            </span>
          </div>
          <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="bench-field bench-model">
              <label>
                <span>Model tag</span>
              </label>
              <select
                className="select mono"
                value={tag}
                onChange={(e) => setTag(e.target.value)}
                disabled={models.length === 0}
              >
                <option value="" disabled>
                  {models.length === 0 ? "no local models found" : "pick a model…"}
                </option>
                {models.map((m) => (
                  <option key={m.tag} value={m.tag}>
                    {m.tag} — {m.size}
                    {m.tag.endsWith("-draft") ? " (draft companion)" : ""}
                  </option>
                ))}
              </select>
            </div>
            <Field
              label="Runs"
              hint="--runs"
              value={runs}
              onChange={setRuns}
              placeholder="3"
              width={140}
            />
          </div>
        </div>

        {hipfireBench.running && (
          <div className="panel">
            <div className="panel-head">
              <span
                className="pulse"
                style={{ background: "var(--yellow)", boxShadow: "0 0 8px var(--yellow)" }}
              />
              Running hipfire bench…
              <span className="meta" style={{ marginLeft: "auto" }}>
                {tag}
              </span>
            </div>
            <div className="panel-body">
              <div className="bench-progress">
                {hipfireBench.lines.length === 0
                  ? "warming up…"
                  : hipfireBench.lines.slice(-60).join("\n")}
              </div>
            </div>
          </div>
        )}

        {result && !hipfireBench.running && result.ok && (
          <HipfireResultCard tag={result.tag} summary={result.summary} output={result.output} />
        )}

        {!hipfireBench.running && !result && models.length > 0 && (
          <div className="panel">
            <div className="panel-body" style={{ fontSize: 12.5, color: "var(--muted)" }}>
              No results yet. Pick a model tag above and hit <strong>Run benchmark</strong>.
            </div>
          </div>
        )}

        <div className="engine-source mono">
          <I.Info size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
          hipfire bench results are session-only for now — not added to a persisted history
          (llama-bench&apos;s run-history shape doesn&apos;t cleanly fit hipfire&apos;s summary).
        </div>
      </div>
    </>
  );
}
