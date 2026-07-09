import { useEffect, useMemo, useState } from "react";
import { I } from "../icons";
import { FLAG_GROUPS, defaultFlags, type FlagDef } from "../data";
import { BinaryLocator } from "./BinaryLocator";
import { useAppStore } from "../state";
import { useShallow } from "zustand/react/shallow";
import { api } from "../lib/api";
import { buildArgs, type FlagValue } from "../lib/buildArgs";
import { useConfirm } from "../components/ConfirmDialog";

function FlagRow({
  f,
  value,
  onChange,
  onBrowse,
  extra,
}: Readonly<{
  f: FlagDef;
  value: FlagValue;
  onChange: (v: FlagValue) => void;
  onBrowse?: () => void;
  extra?: React.ReactNode;
}>) {
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
              cursor: "pointer",
              userSelect: "none",
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
            title={`Use sentinel value ${alias.value}`}
          >
            <input
              type="checkbox"
              checked={isAlias}
              onChange={(e) => onChange(e.target.checked ? alias.value : max)}
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
            disabled={isAlias}
          />
        </div>
        <input
          className="input num mono"
          value={isAlias ? alias.label.toLowerCase() : String(v)}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) onChange(n);
          }}
          onBlur={() => {
            // Commit-time clamp: keep typing free (so "40" on the way to "4096"
            // isn't snapped to min mid-entry), but never leave the flag holding a
            // value outside the FlagDef's [min, max] once the field loses focus.
            if (isAlias) return;
            const clamped = Math.max(min, Math.min(max, v));
            if (clamped !== v) onChange(clamped);
          }}
          disabled={isAlias}
        />
      </>
    );
  } else if (f.type === "toggle") {
    ctl = (
      <button
        type="button"
        className={"toggle" + (value ? " on" : "")}
        role="switch"
        aria-checked={!!value}
        aria-label={f.label}
        onClick={() => onChange(!value)}
      />
    );
  } else if (f.type === "select") {
    ctl = (
      <select
        className="select mono"
        value={String(value)}
        onChange={(e) => onChange(e.target.value)}
      >
        {f.options?.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  } else if (f.type === "text" || f.type === "path") {
    // The Port field must be an integer in 1–65535. Don't block typing — just
    // flag an out-of-range value inline so the user can correct it.
    const portInvalid = f.key === "port" && !isValidPort(String(value));
    ctl = (
      <>
        <input
          className="input mono"
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          style={{
            flex: 1,
            minWidth: 0,
            ...(portInvalid ? { borderColor: "var(--red)" } : null),
          }}
          placeholder={f.type === "path" ? "(none)" : ""}
          aria-invalid={portInvalid || undefined}
        />
        {onBrowse && (
          <button
            className="btn ghost"
            onClick={onBrowse}
            title="Browse…"
            style={{ flexShrink: 0 }}
          >
            <I.Folder size={11} />
          </button>
        )}
        {portInvalid && (
          <span
            style={{
              color: "var(--red)",
              fontSize: 10.5,
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            1–65535
          </span>
        )}
      </>
    );
  }

  return (
    <div className="cfg-row">
      <div className="lbl">
        <span className="name">{f.label}</span>
        <span className="desc">{f.desc}</span>
      </div>
      <div className="ctl">
        {ctl}
        {extra}
      </div>
      <div className="flag mono">{f.flag}</div>
    </div>
  );
}

export function ConfigureScreen({
  initialTab,
  onTabConsumed,
}: {
  initialTab?: string | null;
  onTabConsumed?: () => void;
}) {
  const {
    flags: vals,
    setFlag,
    pickModel,
    forgetModelConfig,
    setMmproj,
    unpinMmproj,
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
      forgetModelConfig: s.forgetModelConfig,
      setMmproj: s.setMmproj,
      unpinMmproj: s.unpinMmproj,
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
  // Remember the exact startError the user dismissed so the banner stays hidden
  // for that message but re-appears when the store surfaces a *different* error.
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const { confirmElement, confirm } = useConfirm();

  const set = (k: string, v: FlagValue) => setFlag(k, v);

  const args = useMemo(() => buildArgs(vals), [vals]);

  // For the live command preview, render with the resolved binary path.
  const binaryDisplay = "llama-server";

  const est = useMemo(() => {
    const ctx = vals.ctx as number;
    const ctk = vals.ctk as string;
    const ctv = vals.ctv as string;
    const kvBytesPerTok = ctk === "f16" ? 2 : ctk === "f32" ? 4 : 1;
    const vBytesPerTok = ctv === "f16" ? 2 : ctv === "f32" ? 4 : 1;
    const kv = (ctx * 64 * (kvBytesPerTok + vBytesPerTok)) / (1024 * 1024 * 1024);
    const overhead = 0.6;
    // Real weights size comes from the inspected GGUF (modelInfo.size_gb).
    // Unknown when no model is selected or the file size couldn't be read.
    const weights = modelInfo && modelInfo.size_gb > 0 ? modelInfo.size_gb : null;
    const total = weights != null ? weights + kv + overhead : null;
    // Bar widths are proportional to the actual GB. Scale against the total
    // when known; otherwise against the KV+overhead sum so those two bars stay
    // meaningful even before a model is picked.
    const denom = total ?? kv + overhead;
    const pct = (v: number) => (denom > 0 ? Math.min(100, (v / denom) * 100) : 0);
    return {
      weights,
      kv,
      overhead,
      total,
      weightsPct: weights != null ? pct(weights) : 0,
      kvPct: pct(kv),
      overheadPct: pct(overhead),
    };
  }, [vals, modelInfo]);

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
  // True when the user has explicitly set/cleared mmproj for this model, so the
  // projector auto-detect leaves it alone.
  const mmprojPinned = !!modelPath && (settings.mmproj_pinned ?? []).includes(modelPath);
  // Per-model config persists automatically (LM Studio style): selecting a
  // model restores its saved flags, and tweaking flags re-saves them under the
  // model path. Every loaded model gets a slot, so to keep the badge honest we
  // only surface it (and the reset button) once the model has a real
  // customization to remember: a flag that diverges from factory defaults
  // (ignoring the auto-managed `mmproj`), or a pinned projector.
  const hasSavedConfig = useMemo(() => {
    if (!modelPath) return false;
    if ((settings.mmproj_pinned ?? []).includes(modelPath)) return true;
    const saved = settings.model_configs?.[modelPath];
    if (!saved) return false;
    const defaults = defaultFlags();
    return Object.keys(saved).some(
      (k) => k !== "model" && k !== "mmproj" && saved[k] !== defaults[k],
    );
  }, [modelPath, settings.model_configs, settings.mmproj_pinned]);

  const resetModelConfig = async () => {
    if (!modelPath) return;
    const ok = await confirm({
      title: `Reset settings for "${basename(modelPath)}" back to defaults?`,
      body: "This model's saved configuration will be discarded.",
      confirmLabel: "Reset",
      danger: true,
    });
    if (ok) forgetModelConfig();
  };

  // Browse for a projector GGUF and pin it for this model (an explicit choice).
  const pickMmproj = async () => {
    const picked = await api.pickFile();
    if (picked) setMmproj(picked);
  };

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
          {hasSavedConfig && (
            <span
              className="badge ghost"
              title="This model's settings are saved automatically and restored whenever you select it. Click reset to return to defaults."
              style={{ cursor: "help" }}
            >
              <I.Bookmark size={10} /> config saved
            </span>
          )}
          {hasSavedConfig && (
            <button
              className="iconbtn"
              onClick={resetModelConfig}
              title="Reset this model's settings to defaults"
            >
              <I.History size={13} />
            </button>
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
            disabled={busy || !settings.build_dir || !modelPath}
            title={
              !settings.build_dir
                ? "Pick a llama.cpp build directory first"
                : !modelPath
                  ? "Pick a model first"
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

      {startError && startError !== dismissedError && (
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
          <I.Info size={13} style={{ flexShrink: 0 }} />
          <span style={{ flex: 1, minWidth: 0 }}>{startError}</span>
          <button
            className="iconbtn"
            title="Dismiss"
            aria-label="Dismiss error"
            onClick={() => setDismissedError(startError)}
            style={{ flexShrink: 0, width: 20, height: 20, color: "var(--red)" }}
          >
            <I.X size={12} />
          </button>
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

      <div className="page-body">
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
                  // Filename-based MTP detection couldn't confirm heads and no
                  // explicit drafter is set. This is a caution, not a blocker:
                  // the drafter is optional and many MTP GGUFs embed the heads
                  // without advertising them in the name.
                  const mtpUnconfirmed = !!modelInfo && !modelInfo.mtp_support && !mtpDrafter;
                  // DFlash needs an explicit drafter GGUF; without one buildArgs
                  // emits no --spec-type and llama-server runs unaccelerated.
                  const dflashMissing =
                    vals.spec_type === "draft-dflash" && !vals.model_draft_dflash;
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
                                  : vals.spec_type === "draft-dflash"
                                    ? "DFlash drafter"
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
                            f.key === "model_draft_dflash" ||
                            f.key === "mmproj";
                          const isTemplatePath = f.key === "chat_template_file";
                          const onBrowse =
                            f.key === "model"
                              ? () => pickModel().catch(() => {})
                              : f.key === "mmproj"
                                ? () => pickMmproj().catch(() => {})
                                : isModelPath
                                  ? () => pickGgufFor(f.key).catch(() => {})
                                  : isTemplatePath
                                    ? () => pickTemplateFile().catch(() => {})
                                    : undefined;
                          // mmproj is auto-detected from the model folder unless
                          // the user takes control; editing it pins the choice,
                          // and the trailing control flips between "auto" (a
                          // hint) and a revert button (when pinned).
                          const extra =
                            f.key !== "mmproj" ? undefined : mmprojPinned ? (
                              <button
                                className="btn ghost"
                                style={{ flexShrink: 0 }}
                                title="Revert to auto-detecting the projector from the model's folder"
                                onClick={() => unpinMmproj()}
                              >
                                <I.History size={11} /> auto
                              </button>
                            ) : modelInfo && modelInfo.mmproj_siblings.length > 0 ? (
                              <span
                                className="badge ghost"
                                style={{ flexShrink: 0, cursor: "help" }}
                                title="Auto-detected from the model's folder. Edit or clear to override."
                              >
                                auto
                              </span>
                            ) : undefined;
                          return (
                            <FlagRow
                              key={f.key}
                              f={f}
                              value={vals[f.key] ?? f.value}
                              onChange={
                                f.key === "mmproj"
                                  ? (v) => setMmproj(String(v))
                                  : (v) => set(f.key, v)
                              }
                              onBrowse={onBrowse}
                              extra={extra}
                            />
                          );
                        })}
                        {g.id === "spec" && vals.spec_type === "draft-mtp" && (
                          <div
                            style={{
                              padding: "10px 16px",
                              borderTop: "1px solid var(--border)",
                              background: mtpUnconfirmed ? "var(--yellow-soft)" : "var(--surface)",
                              fontSize: 11.5,
                              color: mtpUnconfirmed ? "var(--yellow)" : "var(--muted)",
                              display: "flex",
                              gap: 10,
                              alignItems: "flex-start",
                            }}
                          >
                            <I.Info
                              size={13}
                              style={{
                                marginTop: 1,
                                color: mtpUnconfirmed ? "var(--yellow)" : "var(--accent)",
                              }}
                            />
                            <div>
                              {mtpUnconfirmed ? (
                                <>
                                  This GGUF&apos;s filename doesn&apos;t advertise MTP heads. The
                                  drafter below is <strong>optional</strong> — if the model embeds
                                  the heads, <span className="mono">draft-mtp</span> works as-is. If
                                  it doesn&apos;t, llama-server will refuse to start; set an MTP
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
                        {g.id === "spec" && vals.spec_type === "draft-dflash" && (
                          <div
                            style={{
                              padding: "10px 16px",
                              borderTop: "1px solid var(--border)",
                              background: dflashMissing ? "var(--yellow-soft)" : "var(--surface)",
                              fontSize: 11.5,
                              color: dflashMissing ? "var(--yellow)" : "var(--muted)",
                              display: "flex",
                              gap: 10,
                              alignItems: "flex-start",
                            }}
                          >
                            <I.Info
                              size={13}
                              style={{
                                marginTop: 1,
                                color: dflashMissing ? "var(--yellow)" : "var(--accent)",
                              }}
                            />
                            <div>
                              {dflashMissing ? (
                                <>
                                  No DFlash drafter set yet — pick a{" "}
                                  <span className="mono">--model-draft</span> GGUF above, or DFlash
                                  stays off and llama-server runs without speculation.
                                </>
                              ) : (
                                <>
                                  DFlash drafts a whole <strong>block</strong> of tokens per step
                                  with a small block-diffusion drafter, then the target verifies
                                  them — lossless, and strongest on code and structured output.
                                  Block size, target layers and mask token are read from the drafter
                                  GGUF&apos;s metadata;{" "}
                                  <span className="mono">--spec-draft-n-max</span> is clamped to
                                  that block size. Requires a llama.cpp build with the DFlash patch
                                  (<span className="mono">draft-dflash</span>, PR #22105).
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
                  <I.Info size={11} style={{ verticalAlign: -1 }} /> {args.length} tokens
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
                  {est.weights != null ? (
                    <div className="bar">
                      <i style={{ width: `${est.weightsPct}%` }} />
                    </div>
                  ) : (
                    <span style={{ fontSize: 11, color: "var(--muted)", fontStyle: "italic" }}>
                      select a model
                    </span>
                  )}
                  <span className="val">
                    {est.weights != null ? `${est.weights.toFixed(2)} GB` : "—"}
                  </span>
                </div>
                <div className="thr-row">
                  <span className="lbl">KV cache</span>
                  <div className="bar">
                    <i style={{ width: `${est.kvPct}%`, background: "var(--cyan)" }} />
                  </div>
                  <span className="val">{est.kv.toFixed(2)} GB</span>
                </div>
                <div className="thr-row">
                  <span className="lbl">Overhead</span>
                  <div className="bar">
                    <i style={{ width: `${est.overheadPct}%`, background: "var(--yellow)" }} />
                  </div>
                  <span className="val">{est.overhead.toFixed(2)} GB</span>
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
                    <i style={{ width: `${est.total != null ? 100 : 0}%` }} />
                  </div>
                  <span className="val mono" style={{ color: "var(--text)" }}>
                    {est.total != null ? `${est.total.toFixed(2)} GB` : "—"}
                  </span>
                </div>
              </div>
            </div>
          </aside>
        </div>
      </div>
      {confirmElement}
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

// A valid TCP port is an integer in 1–65535.
function isValidPort(s: string): boolean {
  const n = Number(s);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}
