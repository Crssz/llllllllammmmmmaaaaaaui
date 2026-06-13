import { useState } from "react";
import { I } from "../icons";
import { api, type BenchRequest, type BenchRow } from "../lib/api";
import { useAppStore } from "../state";
import { useShallow } from "zustand/react/shallow";

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
          <th className="num">ngl</th>
          <th className="num">batch</th>
          <th>fa</th>
          <th>kv</th>
          <th className="num">t/s</th>
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
    })),
  );

  // Seed the form from the current server config so the benchmark reflects how
  // the user actually runs the model. These are local — running a benchmark
  // never mutates the Configure flags.
  const [model, setModel] = useState<string>(
    () => (useAppStore.getState().flags.model as string) || "",
  );
  const [nPrompt, setNPrompt] = useState("512");
  const [nGen, setNGen] = useState("128");
  const [ngl, setNgl] = useState<string>(() => {
    const v = useAppStore.getState().flags.ngl;
    return v === undefined || v === null || v === "" ? "999" : String(v);
  });
  const [threads, setThreads] = useState<string>(() => {
    const v = useAppStore.getState().flags.threads;
    return v === undefined || v === null ? "" : String(v);
  });
  const [batch, setBatch] = useState("2048");
  const [ubatch, setUbatch] = useState("");
  const [fa, setFa] = useState<string>(() =>
    (useAppStore.getState().flags.fa as boolean) ? "on" : "auto",
  );
  const [reps, setReps] = useState("3");
  const [label, setLabel] = useState("");

  const benchMissing = Boolean(buildDir) && benchBinary != null && !benchBinary.ok;
  const canRun = !bench.running && Boolean(model) && Boolean(buildDir) && !benchMissing;

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
    const f = useAppStore.getState().flags;
    if (f.model) setModel(f.model as string);
    if (f.ngl !== undefined) setNgl(String(f.ngl));
    if (f.threads !== undefined) setThreads(String(f.threads));
    if (f.batch !== undefined) setBatch(String(f.batch));
    setFa((f.fa as boolean) ? "on" : "auto");
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
            <button className="btn primary" onClick={onRun} disabled={!canRun}>
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
                title="Copy model + ngl/threads/batch/fa from the Configure tab"
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
                        tabIndex={-1}
                        title="Delete run"
                        onClick={(e) => {
                          e.stopPropagation();
                          benchDeleteRun(r.id);
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
    </>
  );
}
