import { useEffect, useMemo, useState } from "react";
import { I } from "../icons";
import { FLAG_GROUPS, MODEL, type Agency, type FlagDef } from "../data";
import { BinaryLocator } from "./BinaryLocator";
import { useAppStore } from "../state";
import { useShallow } from "zustand/react/shallow";
import { api } from "../lib/api";
import { buildArgs, type FlagValue } from "../lib/buildArgs";

function FlagRow({
  f,
  value,
  onChange,
  agency,
  onBrowse,
}: Readonly<{
  f: FlagDef;
  value: FlagValue;
  onChange: (v: FlagValue) => void;
  agency: Agency;
  onBrowse?: () => void;
}>) {
  const showSuggestion = agency === "suggest" && f.suggest !== undefined && f.suggest !== value;
  const lockedByAuto = agency === "auto" && f.suggest !== undefined;

  let ctl: React.ReactNode = null;
  if (f.type === "slider") {
    const v = value as number;
    const min = f.min ?? 0;
    const max = f.max ?? 1;
    const alias = f.maxAlias;
    const isAlias = v === alias?.value;
    // Clamp display value to [min, max] so the slider track stays sensible
    // when the underlying value is a sentinel like 999.
    const displayVal = isAlias ? max : Math.max(min, Math.min(max, v));
    const pct = ((displayVal - min) / (max - min)) * 100;
    const fallback = typeof f.suggest === "number" ? f.suggest : max;
    ctl = (
      <>
        {alias && (
          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              fontSize: 11,
              color: isAlias ? "var(--accent)" : "var(--muted)",
              cursor: lockedByAuto ? "default" : "pointer",
              userSelect: "none",
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
            title={`Use sentinel value ${alias.value}`}
          >
            <input
              type="checkbox"
              checked={isAlias}
              disabled={lockedByAuto}
              onChange={(e) => onChange(e.target.checked ? alias.value : fallback)}
              style={{ margin: 0 }}
            />
            {alias.label}
          </label>
        )}
        <div className="slider" style={isAlias ? { opacity: 0.5 } : undefined}>
          <div className="fill" style={{ width: `calc(${pct}% - 1px)` }} />
          <input
            type="range"
            min={min}
            max={max}
            step={f.step}
            value={displayVal}
            onChange={(e) => onChange(Number(e.target.value))}
            disabled={lockedByAuto || isAlias}
          />
        </div>
        <input
          className="input num mono"
          value={lockedByAuto ? String(f.suggest) : isAlias ? alias.label.toLowerCase() : String(v)}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) onChange(n);
          }}
          disabled={lockedByAuto || isAlias}
        />
        {showSuggestion && <span className="ghost-hint">→ {String(f.suggest)}</span>}
      </>
    );
  } else if (f.type === "toggle") {
    ctl = (
      <button
        className={"toggle" + (value ? " on" : "")}
        onClick={() => !lockedByAuto && onChange(!value)}
        disabled={lockedByAuto}
      />
    );
  } else if (f.type === "select") {
    ctl = (
      <select
        className="select mono"
        value={String(value)}
        onChange={(e) => onChange(e.target.value)}
        disabled={lockedByAuto}
      >
        {f.options?.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  } else if (f.type === "text" || f.type === "path") {
    ctl = (
      <>
        <input
          className="input mono"
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          style={{ flex: 1, minWidth: 0 }}
          disabled={lockedByAuto}
          placeholder={f.type === "path" ? "(none)" : ""}
        />
        {onBrowse && (
          <button
            className="btn ghost"
            onClick={onBrowse}
            disabled={lockedByAuto}
            title="Browse…"
            style={{ flexShrink: 0 }}
          >
            <I.Folder size={11} />
          </button>
        )}
      </>
    );
  }

  return (
    <div className="cfg-row">
      <div className="lbl">
        <span className="name">
          {f.label}
          {lockedByAuto && (
            <span className="badge accent" style={{ fontSize: 9.5, padding: "1px 5px" }}>
              <I.Lock size={9} /> auto
            </span>
          )}
        </span>
        <span className="desc">{f.desc}</span>
      </div>
      <div className="ctl">{ctl}</div>
      <div className="flag mono">{f.flag}</div>
    </div>
  );
}

export function ConfigureScreen({
  agency,
  initialTab,
  onTabConsumed,
}: {
  agency: Agency;
  initialTab?: string | null;
  onTabConsumed?: () => void;
}) {
  const {
    flags: vals,
    setFlag,
    pickModel,
    startServer,
    stopServer,
    server,
    startError,
    settings,
    modelInfo,
    modelInfoError,
  } = useAppStore(
    useShallow((s) => ({
      flags: s.flags,
      setFlag: s.setFlag,
      pickModel: s.pickModel,
      startServer: s.startServer,
      stopServer: s.stopServer,
      server: s.server,
      startError: s.startError,
      settings: s.settings,
      modelInfo: s.modelInfo,
      modelInfoError: s.modelInfoError,
    })),
  );

  const [open, setOpen] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(FLAG_GROUPS.map((g) => [g.id, g.defaultOpen])),
  );
  const [tab, setTab] = useState<string>("all");

  // One-shot tab navigation triggered from the parent. The `onTabConsumed`
  // callback flips the parent's state so this effect doesn't re-fire.
  useEffect(() => {
    if (initialTab) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTab(initialTab);
      onTabConsumed?.();
    }
  }, [initialTab, onTabConsumed]);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const set = (k: string, v: FlagValue) => setFlag(k, v);

  const args = useMemo(() => buildArgs(vals, agency), [vals, agency]);

  // For the live command preview, render with the resolved binary path.
  const binaryDisplay = "llama-server";

  const est = useMemo(() => {
    const w = MODEL.size_gb;
    const ctx = vals.ctx as number;
    const ctk = vals.ctk as string;
    const ctv = vals.ctv as string;
    const kvBytesPerTok = ctk === "f16" ? 2 : ctk === "f32" ? 4 : 1;
    const vBytesPerTok = ctv === "f16" ? 2 : ctv === "f32" ? 4 : 1;
    const kv = (ctx * 64 * (kvBytesPerTok + vBytesPerTok)) / (1024 * 1024 * 1024);
    const total = w + kv + 0.6;
    return { total: total.toFixed(2), kv: kv.toFixed(2), weights: w.toFixed(2) };
  }, [vals]);

  // Browse for a GGUF and store it under the given flag key. The store's
  // pickModel() is only correct for the main "model" flag.
  const pickGgufFor = async (key: string) => {
    const picked = await api.pickFile();
    if (picked) set(key, picked);
  };

  const pickTemplateFile = async () => {
    const picked = await api.pickFile("Select chat template file", [
      "jinja",
      "jinja2",
      "j2",
      "txt",
      "tmpl",
    ]);
    if (picked) set("chat_template_file", picked);
  };

  const reload = async () => {
    setBusy(true);
    try {
      if (server.running) await stopServer();
      await startServer(args);
    } finally {
      setBusy(false);
    }
  };

  const eject = async () => {
    setBusy(true);
    try {
      await stopServer();
    } finally {
      setBusy(false);
    }
  };

  const copyCommand = () => {
    const text = `llama-server ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`;
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const modelPath = (vals.model as string) || "";

  return (
    <>
      <div className="page-head">
        <div>
          <div className="crumb">Configure / llama-server</div>
          <h1>Runtime configuration</h1>
        </div>
        <div className="head-meta">
          <span
            className="badge ghost mono"
            title={modelPath}
            style={{
              maxWidth: 320,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              display: "inline-block",
            }}
          >
            {modelPath ? basename(modelPath) : "no model selected"}
          </span>
          {modelInfo && (
            <span
              className="badge ghost mono"
              title={`Architecture: ${modelInfo.architecture ?? "?"}\nGGUF v${modelInfo.gguf_version}, ${modelInfo.tensor_count} tensors${modelInfo.context_length ? `\nNative ctx: ${modelInfo.context_length.toLocaleString()}` : ""}`}
            >
              {modelInfo.architecture ?? "?"}
            </span>
          )}
          {modelInfo && (
            <span
              className={"badge " + (modelInfo.mtp_support ? "accent" : "ghost")}
              title={
                modelInfo.mtp_support
                  ? "Filename advertises MTP heads — speculative decoding via MTP is available."
                  : "Filename has no -MTP marker — speculative decoding via MTP isn't available for this model."
              }
            >
              <I.Spark size={10} /> MTP {modelInfo.mtp_support ? "✓" : "—"}
            </span>
          )}
          {modelInfoError && (
            <span className="badge red" title={modelInfoError} style={{ cursor: "help" }}>
              GGUF read failed
            </span>
          )}
          {server.running ? (
            <span className="badge green">
              <span className="dot" />
              running · :{server.info?.port}
            </span>
          ) : (
            <span className="badge ghost">
              <span className="dot" /> stopped
            </span>
          )}
          {server.running ? (
            <button className="btn" onClick={eject} disabled={busy} title="Stop llama-server">
              <I.Stop size={12} /> Stop
            </button>
          ) : null}
          <button
            className="btn primary"
            onClick={reload}
            disabled={busy || !settings.build_dir}
            title={
              !settings.build_dir
                ? "Pick a llama.cpp build directory first"
                : server.running
                  ? "Restart with current flags"
                  : "Start llama-server"
            }
          >
            <I.Refresh
              size={12}
              style={{ animation: busy ? "spin 0.9s linear infinite" : "none" }}
            />{" "}
            {server.running ? "Reload" : "Start"}
          </button>
        </div>
      </div>

      {startError && (
        <div
          style={{
            margin: "10px 28px 0",
            padding: "10px 14px",
            background: "var(--red-soft)",
            border: "1px solid oklch(0.55 0.16 25 / 0.45)",
            borderRadius: "var(--radius)",
            color: "var(--red)",
            fontSize: 12.5,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <I.Info size={13} />
          {startError}
        </div>
      )}

      <div
        style={{
          padding: "0 28px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg)",
        }}
      >
        <div className="section-tabs">
          {[
            "all",
            "binary",
            "model",
            "context",
            "hw",
            "memory",
            "spec",
            "templates",
            "rope",
            "server",
          ].map((t) => (
            <button
              key={t}
              className={"section-tab" + (tab === t ? " active" : "")}
              onClick={() => setTab(t)}
            >
              {t === "all"
                ? "All"
                : t === "hw"
                  ? "Hardware"
                  : t === "spec"
                    ? "Speculative"
                    : t === "binary"
                      ? "Binary"
                      : t === "templates"
                        ? "Templates"
                        : t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <div className="page-body" data-agency={agency}>
        <div className="cfg-grid">
          <div>
            {(tab === "all" || tab === "binary") && <BinaryLocator />}
            {tab === "binary"
              ? null
              : FLAG_GROUPS.filter((g) => tab === "all" || g.id === tab).map((g) => {
                  const flags =
                    g.id === "spec"
                      ? g.flags.filter((f) => !f.only || f.only === vals.spec_type)
                      : g.flags;
                  const IconCmp = I[g.icon];
                  // With an explicit MTP drafter GGUF the heads come from the
                  // drafter, so the main model not having them is fine.
                  const mtpDrafter = Boolean(vals.model_draft_mtp);
                  const mtpMissing = !!modelInfo && !modelInfo.mtp_support && !mtpDrafter;
                  return (
                    <div key={g.id} className={"cfg-section" + (open[g.id] ? "" : " collapsed")}>
                      <button
                        type="button"
                        className="cfg-section-head"
                        onClick={() => setOpen((s) => ({ ...s, [g.id]: !s[g.id] }))}
                      >
                        <IconCmp size={14} />
                        <span>{g.label}</span>
                        {g.id === "spec" &&
                          vals.spec_type !== "none" &&
                          vals.spec_type !== "off" && (
                            <span className="badge accent" style={{ marginLeft: 6, fontSize: 10 }}>
                              <span className="dot" />
                              {vals.spec_type === "draft-mtp"
                                ? "MTP heads"
                                : vals.spec_type === "draft-simple"
                                  ? "draft model"
                                  : (vals.spec_type as string)}
                            </span>
                          )}
                        <span className="sec-count">
                          {flags.length} flag{flags.length === 1 ? "" : "s"}
                        </span>
                        <I.Chevron size={14} />
                      </button>
                      <div className="cfg-rows">
                        {flags.map((f) => {
                          const isModelPath =
                            f.key === "model" ||
                            f.key === "model_draft" ||
                            f.key === "model_draft_mtp" ||
                            f.key === "mmproj";
                          const isTemplatePath = f.key === "chat_template_file";
                          const onBrowse =
                            f.key === "model"
                              ? () => pickModel().catch(() => {})
                              : isModelPath
                                ? () => pickGgufFor(f.key).catch(() => {})
                                : isTemplatePath
                                  ? () => pickTemplateFile().catch(() => {})
                                  : undefined;
                          return (
                            <FlagRow
                              key={f.key}
                              f={f}
                              value={vals[f.key] ?? f.value}
                              onChange={(v) => set(f.key, v)}
                              agency={agency}
                              onBrowse={onBrowse}
                            />
                          );
                        })}
                        {g.id === "spec" && vals.spec_type === "draft-mtp" && (
                          <div
                            style={{
                              padding: "10px 16px",
                              borderTop: "1px solid var(--border)",
                              background: mtpMissing ? "var(--red-soft)" : "var(--surface)",
                              fontSize: 11.5,
                              color: mtpMissing ? "var(--red)" : "var(--muted)",
                              display: "flex",
                              gap: 10,
                              alignItems: "flex-start",
                            }}
                          >
                            <I.Info
                              size={13}
                              style={{
                                marginTop: 1,
                                color: mtpMissing ? "var(--red)" : "var(--accent)",
                              }}
                            />
                            <div>
                              {mtpMissing ? (
                                <>
                                  The selected GGUF does <strong>not</strong> contain MTP heads —
                                  llama-server will refuse to start with{" "}
                                  <span className="mono">--spec-type draft-mtp</span>. Set an MTP
                                  drafter GGUF above, or switch to{" "}
                                  <span className="mono">none</span> or{" "}
                                  <span className="mono">draft-simple</span>.
                                </>
                              ) : mtpDrafter ? (
                                <>
                                  Explicit MTP drafter — heads load from the drafter GGUF via{" "}
                                  <span className="mono">--model-draft</span>.
                                </>
                              ) : modelInfo?.mtp_support ? (
                                <>
                                  Filename advertises MTP — heads load from the model GGUF, no
                                  separate draft model needed.
                                </>
                              ) : (
                                <>
                                  MTP heads load from the model GGUF — no separate draft model
                                  needed. Memory overhead is ~10% of the target. Best with Qwen 3.6
                                  MTP and DeepSeek-V3 MTP GGUFs.
                                </>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
          </div>

          <aside>
            <div className="cmd-panel">
              <div className="cmd-head">
                <span className="title">
                  <I.Terminal /> Generated command
                </span>
                <button
                  className="btn ghost copy"
                  title={copied ? "Copied!" : "Copy"}
                  onClick={copyCommand}
                >
                  {copied ? <I.Check size={12} /> : <I.Copy size={12} />}
                </button>
              </div>
              <div className="cmd-body mono">
                <span className="line">
                  <span className="prompt">$ </span>
                  <span className="bin">{binaryDisplay}</span> \
                </span>
                {renderArgLines(args)}
              </div>
              <div className="cmd-foot">
                <span>
                  <I.Info size={11} style={{ verticalAlign: -1 }} /> {args.length} tokens ·{" "}
                  {agency === "auto" ? "pilot-controlled" : "you control these"}
                </span>
              </div>
            </div>

            <div className="panel" style={{ marginTop: 12 }}>
              <div className="panel-head">
                <I.Mem size={14} /> Estimated memory
                <span className="meta">est.</span>
              </div>
              <div
                className="panel-body"
                style={{ display: "flex", flexDirection: "column", gap: 10 }}
              >
                <div className="thr-row">
                  <span className="lbl">Weights</span>
                  <div className="bar">
                    <i style={{ width: "62%" }} />
                  </div>
                  <span className="val">{est.weights} GB</span>
                </div>
                <div className="thr-row">
                  <span className="lbl">KV cache</span>
                  <div className="bar">
                    <i
                      style={{
                        width: `${Math.min(80, Number(est.kv) * 10)}%`,
                        background: "var(--cyan)",
                      }}
                    />
                  </div>
                  <span className="val">{est.kv} GB</span>
                </div>
                <div className="thr-row">
                  <span className="lbl">Overhead</span>
                  <div className="bar">
                    <i style={{ width: "8%", background: "var(--yellow)" }} />
                  </div>
                  <span className="val">0.60 GB</span>
                </div>
                <div
                  style={{
                    height: 1,
                    background: "var(--border)",
                    margin: "2px 0",
                  }}
                />
                <div className="thr-row" style={{ fontWeight: 600 }}>
                  <span className="lbl" style={{ color: "var(--text)" }}>
                    Total
                  </span>
                  <div className="bar">
                    <i style={{ width: "78%" }} />
                  </div>
                  <span className="val mono" style={{ color: "var(--text)" }}>
                    {est.total} GB
                  </span>
                </div>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </>
  );
}

// Render argv as pretty lines, grouping each flag with its value when the
// next token doesn't start with "--" (i.e. it's the flag's value).
function renderArgLines(args: string[]): React.ReactNode {
  const lines: { flag: string; val?: string }[] = [];
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    const next = args[i + 1];
    if (a.startsWith("--") && next !== undefined && !next.startsWith("--")) {
      lines.push({ flag: a, val: next });
      i += 2;
    } else {
      lines.push({ flag: a });
      i += 1;
    }
  }
  return lines.map((l, idx) => (
    <span className="line" key={idx}>
      {"   "}
      <span className="flag">{l.flag}</span>
      {l.val !== undefined && (
        <>
          {" "}
          <span className="val">{l.val}</span>
        </>
      )}
      {idx < lines.length - 1 ? " \\" : ""}
    </span>
  ));
}

function basename(p: string): string {
  const sep = p.includes("\\") ? "\\" : "/";
  return p.split(sep).pop() || p;
}
