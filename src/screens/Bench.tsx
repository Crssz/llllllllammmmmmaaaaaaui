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

/** Every field of the llama-bench form, in one object so it can be cached
 *  wholesale across unmounts (see `formCache`). All values are strings because
 *  each numeric field also accepts a comma-separated sweep. */
type BenchForm = {
  model: string;
  nPrompt: string;
  nGen: string;
  ngl: string;
  threads: string;
  batch: string;
  ubatch: string;
  ctk: string;
  ctv: string;
  fa: string;
  reps: string;
  label: string;
};

function initialForm(f: FlagValues): BenchForm {
  return { ...benchFromConfig(f), nPrompt: "512", nGen: "128", reps: "3", label: "" };
}

// App.tsx is a single-component router (`{tab === "bench" && <Bench/>}`), so
// switching tabs unmounts this screen and destroys every local useState — a
// user who stepped away mid-run came back to a wiped form. The draft is cached
// in module scope rather than in benchSlice because it is transient UI state:
// benchSlice's other fields are all persisted to bench_runs.json, and a
// half-typed form has no business landing on disk. See the report for the
// slice-owned alternative if this should outlive a reload.
let formCache: BenchForm | null = null;

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

// llama-bench measures two different things and reports both under a bare
// "t/s": prompt processing (pp — prefill, massively parallel) and token
// generation (tg — decode, memory-bandwidth bound). They differ by an order of
// magnitude on identical hardware, so a pp number and a tg number must never be
// ranked or scaled against each other — the winner of a mixed comparison is
// always just the pp row. Every row is classified here and only ever compared
// within its own metric. `pg` is llama-bench's combined -pg mode (prefill and
// decode measured in one row), which is a third quantity again.
const METRICS = ["pp", "tg", "pg"] as const;
type BenchMetric = (typeof METRICS)[number];

const METRIC_LABEL: Record<
  BenchMetric,
  { cell: string; heading: string; badge: string; hint: string }
> = {
  pp: {
    cell: "prefill",
    heading: "Prefill · prompt processing (tokens/s)",
    badge: "pp",
    hint: "Best prefill (prompt processing) throughput, tokens/s",
  },
  tg: {
    cell: "decode",
    heading: "Decode · token generation (tokens/s)",
    badge: "tg",
    hint: "Best decode (token generation) throughput, tokens/s",
  },
  pg: {
    cell: "prefill+decode",
    heading: "Prefill + decode · combined (tokens/s)",
    badge: "pp+tg",
    hint: "Best combined prefill+decode throughput, tokens/s",
  },
};

// Mirrors rowLabel's branching — the two must agree on what a row measures.
function rowMetric(r: BenchRow): BenchMetric {
  if (r.n_prompt > 0 && r.n_gen === 0) return "pp";
  if (r.n_gen > 0 && r.n_prompt === 0) return "tg";
  return "pg";
}

type MetricGroup = { metric: BenchMetric; rows: BenchRow[]; top: number };

/** Rows split by metric, each group carrying its own maximum. Bar widths scale
 *  against `top`; "best" is decided by isGroupBest. */
function groupByMetric(rows: BenchRow[]): MetricGroup[] {
  return METRICS.map((metric) => {
    const g = rows.filter((r) => rowMetric(r) === metric);
    return { metric, rows: g, top: g.reduce((mx, r) => Math.max(mx, r.avg_ts), 0) };
  }).filter((g) => g.rows.length > 0);
}

/** A group of one has nothing to beat, so it gets no winner — otherwise the
 *  default one-pp-row/one-tg-row pair would light up as two "best" results. */
function isGroupBest(g: MetricGroup, r: BenchRow): boolean {
  return g.rows.length > 1 && g.top > 0 && r.avg_ts === g.top;
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

// A history row's delete control is hidden until the row is hovered, which
// leaves it unreachable for keyboard users. `.bench-run` has no focus-reveal
// rule (styles.css is owned elsewhere — see the report), so the row tracks
// keyboard focus itself and overrides `.rdel { opacity: 0 }` inline.
// `:focus-visible` rather than `:focus` so a mouse click, already covered by
// `:hover`, doesn't latch the control open after the pointer leaves.
function isKeyboardFocus(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  try {
    return target.matches(":focus-visible");
  } catch {
    return true; // engine without :focus-visible — reveal on any focus
  }
}

function kvLabel(r: BenchRow): string {
  return r.type_k && r.type_v ? `${r.type_k}/${r.type_v}` : "—";
}

// Clipboard exports for a saved run, mirroring the ResultsTable columns.
function runToMarkdown(r: BenchRun): string {
  const lines = r.rows.map(
    (row) =>
      `| ${METRIC_LABEL[rowMetric(row)].cell} | ${rowLabel(row)} | ` +
      `${nglLabel(row.n_gpu_layers)} | ${row.n_batch || "—"} | ` +
      `${faLabel(row.flash_attn)} | ${kvLabel(row)} | ${row.avg_ts.toFixed(2)} | ` +
      `${row.stddev_ts > 0 ? row.stddev_ts.toFixed(2) : "—"} |`,
  );
  return [
    `### ${r.label} — ${basename(r.model_path)}`,
    "",
    "| metric | test | ngl | batch | fa | kv | t/s | ± stddev |",
    "| --- | --- | ---: | ---: | --- | --- | ---: | ---: |",
    ...lines,
  ].join("\n");
}

function runToCsv(r: BenchRun): string {
  const lines = r.rows.map((row) =>
    [
      METRIC_LABEL[rowMetric(row)].cell,
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
  return ["metric,test,ngl,batch,fa,kv,avg_ts,stddev_ts,avg_ns", ...lines].join("\n");
}

// Panel and group titles are real headings so the screen has a document
// outline under its <h1>, but they must look exactly like the styled text they
// replace. `.panel-head` already fixes the size and weight of its own text, so
// a heading inside it only has to drop the UA margin and inherit the rest;
// group titles inside a panel body carry the same declarations the plain <div>
// used to, plus an explicit weight so the UA's bold doesn't leak in.
const PANEL_TITLE: React.CSSProperties = {
  margin: 0,
  fontSize: "inherit",
  fontWeight: "inherit",
};
const GROUP_TITLE: React.CSSProperties = {
  margin: "0 0 6px",
  fontSize: 11,
  fontWeight: "inherit",
  color: "var(--subtle)",
};

// A numeric/text field that accepts a single value or a comma-separated sweep.
// `id` is required: it ties the visible <label> to the input, so the label text
// on screen is also the control's accessible name.
function Field({
  id,
  label,
  value,
  onChange,
  placeholder,
  hint,
  width,
}: Readonly<{
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
  width?: number;
}>) {
  return (
    <div className="bench-field" style={width ? { maxWidth: width } : undefined}>
      <label htmlFor={id}>
        <span>{label}</span>
        {hint && <span className="hint">{hint}</span>}
      </label>
      <input
        id={id}
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
  const groups = groupByMetric(rows);
  const groupOf = new Map(groups.map((g) => [g.metric, g]));
  return (
    <table className="bench-table">
      <thead>
        <tr>
          <th title="What the row measures — prefill and decode throughput are not comparable">
            metric
          </th>
          <th>test</th>
          <th className="num" title="GPU layers">
            ngl
          </th>
          <th className="num">batch</th>
          <th title="Flash attention">fa</th>
          <th title="KV cache type">kv</th>
          <th
            className="num"
            title="Tokens per second, ranked against rows of the same metric only"
          >
            t/s
          </th>
          <th className="num">± stddev</th>
          <th className="num">latency</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const metric = rowMetric(r);
          const group = groupOf.get(metric);
          const isBest = group != null && isGroupBest(group, r);
          const ms = r.avg_ns > 0 ? r.avg_ns / 1e6 : 0;
          return (
            <tr key={i} className={isBest ? "best" : undefined}>
              <td>{METRIC_LABEL[metric].cell}</td>
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

// One bar group per metric, each scaled against its own group maximum. Scaling
// prefill and decode on a shared axis would squash every decode bar to a sliver
// of the prefill winner and imply the two are the same measurement.
function CompareBars({ rows }: Readonly<{ rows: BenchRow[] }>) {
  const groups = groupByMetric(rows).filter((g) => g.top > 0);
  if (groups.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {groups.map((g) => (
        <div key={g.metric}>
          <h3 style={GROUP_TITLE}>{METRIC_LABEL[g.metric].heading}</h3>
          <div className="bench-bars">
            {g.rows.map((r, i) => {
              const pct = (r.avg_ts / g.top) * 100;
              const isBest = isGroupBest(g, r);
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
        </div>
      ))}
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
    benchPending,
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
      benchPending: s.benchPending,
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

  // Which history row is showing its delete control because keyboard focus is
  // inside it (`:hover` covers the mouse; styles.css can't express this yet).
  const [focusedRunId, setFocusedRunId] = useState<string | null>(null);

  // Seed the form from the current server config so the benchmark reflects how
  // the user actually runs the model — but only the first time, since a cached
  // draft is what the user last typed. These are local copies: running a
  // benchmark never mutates the Configure flags.
  const [form, setForm] = useState<BenchForm>(
    () => formCache ?? initialForm(useAppStore.getState().flags),
  );
  useEffect(() => {
    formCache = form;
  }, [form]);
  const setField = (k: keyof BenchForm, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const benchMissing = Boolean(buildDir) && benchBinary != null && !benchBinary.ok;
  const canRun = !bench.running && Boolean(form.model) && Boolean(buildDir) && !benchMissing;
  // First missing prerequisite, surfaced as the disabled button's tooltip so
  // the user isn't left guessing why "Run benchmark" won't click.
  const runDisabledReason = bench.running
    ? "A benchmark is already running"
    : !buildDir
      ? "Pick a llama.cpp build directory first"
      : benchMissing
        ? "llama-bench isn't in this build"
        : !form.model
          ? "Pick a model first"
          : null;

  const onRun = () => {
    if (!buildDir) return;
    const req: BenchRequest = {
      model: form.model,
      n_prompt: form.nPrompt,
      n_gen: form.nGen,
      n_gpu_layers: form.ngl,
      threads: form.threads,
      batch: form.batch,
      ubatch: form.ubatch,
      cache_type_k: form.ctk,
      cache_type_v: form.ctv,
      flash_attn: form.fa,
      reps: Number(form.reps) || 0,
      extra: [],
    };
    benchStart(buildDir, req, form.label).catch(() => {});
  };

  const onBrowse = async () => {
    const picked = await api.pickFile();
    if (picked) {
      setForm((f) => ({ ...f, model: picked, label: f.label || basename(picked) }));
    }
  };

  const syncFromConfig = () => {
    const c = benchFromConfig(useAppStore.getState().flags);
    // keep a hand-picked model if config has none
    setForm((f) => ({ ...f, ...c, model: c.model || f.model }));
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
            <I.Sliders size={14} />
            <h2 style={PANEL_TITLE}>Configuration</h2>
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
              <label htmlFor="bench-model">
                <span>Model</span>
                {form.model && <span className="hint mono">{basename(form.model)}</span>}
              </label>
              <div className="bench-model-row">
                <input
                  id="bench-model"
                  className="input"
                  value={form.model}
                  placeholder="path to a .gguf file"
                  onChange={(e) => setField("model", e.target.value)}
                  spellCheck={false}
                />
                <button className="btn" onClick={() => onBrowse().catch(() => {})}>
                  <I.Folder size={12} /> Browse
                </button>
              </div>
            </div>

            <div className="bench-form">
              <Field
                id="bench-n-prompt"
                label="Prompt tokens"
                hint="-p"
                value={form.nPrompt}
                onChange={(v) => setField("nPrompt", v)}
                placeholder="512"
              />
              <Field
                id="bench-n-gen"
                label="Gen tokens"
                hint="-n"
                value={form.nGen}
                onChange={(v) => setField("nGen", v)}
                placeholder="128"
              />
              <Field
                id="bench-ngl"
                label="GPU layers"
                hint="-ngl"
                value={form.ngl}
                onChange={(v) => setField("ngl", v)}
                placeholder="999"
              />
              <Field
                id="bench-threads"
                label="Threads"
                hint="-t"
                value={form.threads}
                onChange={(v) => setField("threads", v)}
                placeholder="auto"
              />
              <Field
                id="bench-batch"
                label="Batch"
                hint="-b"
                value={form.batch}
                onChange={(v) => setField("batch", v)}
                placeholder="2048"
              />
              <Field
                id="bench-ubatch"
                label="Micro-batch"
                hint="-ub"
                value={form.ubatch}
                onChange={(v) => setField("ubatch", v)}
                placeholder="512"
              />
              <Field
                id="bench-ctk"
                label="K cache"
                hint="-ctk"
                value={form.ctk}
                onChange={(v) => setField("ctk", v)}
                placeholder="f16"
              />
              <Field
                id="bench-ctv"
                label="V cache"
                hint="-ctv"
                value={form.ctv}
                onChange={(v) => setField("ctv", v)}
                placeholder="f16"
              />
              <div className="bench-field">
                <label htmlFor="bench-fa">
                  <span>Flash attn</span>
                  <span className="hint">-fa</span>
                </label>
                <select
                  id="bench-fa"
                  className="select"
                  value={form.fa}
                  onChange={(e) => setField("fa", e.target.value)}
                >
                  <option value="auto">auto</option>
                  <option value="on">on</option>
                  <option value="off">off</option>
                </select>
              </div>
              <Field
                id="bench-reps"
                label="Repetitions"
                hint="-r"
                value={form.reps}
                onChange={(v) => setField("reps", v)}
                placeholder="3"
              />
              <Field
                id="bench-label"
                label="Save as"
                hint="label"
                value={form.label}
                onChange={(v) => setField("label", v)}
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
              <h2 style={PANEL_TITLE}>Running llama-bench…</h2>
              {/* Identify the run from the slice's captured start context, not
                  from the form — the form is editable (and re-seeded on
                  remount) while the run is in flight, so reading it here
                  attributed the run to whatever model is currently typed. */}
              <span
                className="meta"
                style={{ marginLeft: "auto" }}
                title={benchPending?.model || undefined}
              >
                {benchPending ? basename(benchPending.model) : "…"}
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
              <I.Bolt size={14} />
              <h2 style={PANEL_TITLE}>Results</h2>
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
                pp = prefill / prompt processing · tg = decode / token generation · d = context
                depth. Prefill and decode are different measurements — prefill is massively
                parallel, decode is memory-bandwidth bound — so each is ranked and scaled only
                against its own kind.
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
              <I.History size={14} />
              <h2 style={PANEL_TITLE}>History</h2>
              <span className="meta" style={{ marginLeft: "auto" }}>
                {benchRuns.length} run{benchRuns.length === 1 ? "" : "s"}
              </span>
            </div>
            <div className="panel-body">
              <div className="bench-runs">
                {benchRuns.map((r) => (
                  // The row is a plain container: the "view" control and the
                  // "delete" control are sibling buttons, not a button nested
                  // inside a button (which is invalid HTML — the inner control
                  // isn't independently focusable and its activation may never
                  // be delivered).
                  <div
                    key={r.id}
                    className={"bench-run" + (benchViewingId === r.id ? " active" : "")}
                    onContextMenu={(e) => openMenu(e, runMenuItems(r))}
                    onFocus={(e) => {
                      if (isKeyboardFocus(e.target)) setFocusedRunId(r.id);
                    }}
                    onBlur={(e) => {
                      if (!e.currentTarget.contains(e.relatedTarget)) {
                        setFocusedRunId((cur) => (cur === r.id ? null : cur));
                      }
                    }}
                  >
                    <button
                      className="bench-run-open"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        flex: 1,
                        minWidth: 0,
                        textAlign: "left",
                      }}
                      onClick={() => benchSelectRun(r.id)}
                    >
                      <I.Bolt size={13} style={{ color: "var(--muted)", flexShrink: 0 }} />
                      <span className="rname">
                        <span className="rtitle">{r.label}</span>
                        <span className="rsub">
                          {basename(r.model_path)} · {r.rows.length} row
                          {r.rows.length === 1 ? "" : "s"} · {relTime(r.created_at)}
                        </span>
                      </span>
                      {/* One badge per metric present: a single "best t/s"
                          number was always the prefill figure wearing a
                          neutral label. */}
                      {groupByMetric(r.rows).map((g) => (
                        <span
                          key={g.metric}
                          className="badge ghost mono"
                          title={METRIC_LABEL[g.metric].hint}
                          style={{ flexShrink: 0 }}
                        >
                          {METRIC_LABEL[g.metric].badge} {g.top.toFixed(1)} t/s
                        </span>
                      ))}
                    </button>
                    <button
                      className="iconbtn rdel"
                      title="Delete run"
                      aria-label={`Delete run "${r.label}"`}
                      style={focusedRunId === r.id ? { opacity: 1 } : undefined}
                      onClick={() => {
                        requestDeleteRun(r);
                      }}
                    >
                      <I.X size={12} />
                    </button>
                  </div>
                ))}
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
        <I.Bolt size={14} />
        <h2 style={PANEL_TITLE}>Results</h2>
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
                <h3 style={GROUP_TITLE}>Prefill sweep</h3>
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
                <h3 style={GROUP_TITLE}>Decode / TTFT / Wall</h3>
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
          <button
            className="btn ghost"
            aria-expanded={showRaw}
            aria-controls="bench-hipfire-raw"
            onClick={() => setShowRaw((v) => !v)}
          >
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
            <div id="bench-hipfire-raw" className="bench-progress" style={{ marginTop: 8 }}>
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

  // Floor + clamp to u32 range so a decimal (or out-of-range) Runs value can
  // never reach the backend's `runs: u32` param — serde rejects a
  // non-integer float (or a value above u32::MAX) outright, which would
  // otherwise surface as a cryptic deserialize error instead of ever
  // starting the benchmark.
  const U32_MAX = 4294967295;
  const runsN = Math.min(U32_MAX, Math.max(1, Math.floor(Number(runs)) || 1));
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
              style={{
                fontSize: 12.5,
                color: "var(--red)",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
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
            <I.Sliders size={14} />
            <h2 style={PANEL_TITLE}>Configuration</h2>
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
              <label htmlFor="bench-hipfire-tag">
                <span>Model tag</span>
              </label>
              <select
                id="bench-hipfire-tag"
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
              id="bench-hipfire-runs"
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
              <h2 style={PANEL_TITLE}>Running hipfire bench…</h2>
              <span className="meta" style={{ marginLeft: "auto" }}>
                {hipfireBench.tag}
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
