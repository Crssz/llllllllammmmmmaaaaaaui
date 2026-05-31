import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { I } from "../icons";
import { useAppStore } from "../state";
import { api } from "../lib/api";
import { buildMtmdArgs } from "../lib/buildMtmdArgs";

const DEFAULT_PROMPT = "Transcribe the spoken audio into text. Output only the transcript.";

function basename(p: string): string {
  if (!p) return "";
  const sep = p.includes("\\") ? "\\" : "/";
  return p.split(sep).pop() || p;
}

/** Labelled path input with a Browse button. */
function PathField({
  label,
  hint,
  value,
  placeholder,
  onChange,
  onBrowse,
  disabled,
}: {
  label: string;
  hint?: string;
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
  onBrowse: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="tr-field">
      <label>
        {label}
        {hint && <span className="tr-hint"> · {hint}</span>}
      </label>
      <div className="tr-path-row">
        <input
          className="input mono"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          spellCheck={false}
        />
        <button
          className="btn ghost"
          onClick={onBrowse}
          disabled={disabled}
          title={`Browse for ${label.toLowerCase()}`}
        >
          <I.Folder size={12} /> Browse
        </button>
      </div>
    </div>
  );
}

function NumField({
  label,
  value,
  onChange,
  disabled,
  step,
  min,
  placeholder,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  step?: number;
  min?: number;
  placeholder?: string;
}) {
  return (
    <div className="tr-field">
      <label>{label}</label>
      <input
        className="input num mono"
        type="number"
        value={Number.isFinite(value) ? value : ""}
        step={step ?? 1}
        min={min}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === "" ? Number.NaN : Number(e.target.value))}
      />
    </div>
  );
}

function elapsedLabel(startedAt: number | null, now: number): string {
  if (!startedAt) return "";
  const sec = Math.max(0, Math.floor((now - startedAt) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function TranscribeScreen() {
  const {
    trRunning,
    trOutput,
    trLog,
    trError,
    trExitCode,
    trStartedAt,
    startTranscribe,
    cancelTranscribe,
    clearTranscribe,
  } = useAppStore(
    useShallow((s) => ({
      trRunning: s.trRunning,
      trOutput: s.trOutput,
      trLog: s.trLog,
      trError: s.trError,
      trExitCode: s.trExitCode,
      trStartedAt: s.trStartedAt,
      startTranscribe: s.startTranscribe,
      cancelTranscribe: s.cancelTranscribe,
      clearTranscribe: s.clearTranscribe,
    })),
  );
  const build = useAppStore((s) => s.build);
  const buildDir = useAppStore((s) => s.settings.build_dir);

  // Form state seeded from the configured server flags (model + projector are
  // usually already pointed at the right bundle).
  const flags = useAppStore.getState().flags;
  const [model, setModel] = useState<string>((flags.model as string) || "");
  const [mmproj, setMmproj] = useState<string>((flags.mmproj as string) || "");
  const [audio, setAudio] = useState<string>("");
  const [prompt, setPrompt] = useState<string>(DEFAULT_PROMPT);
  const [ngl, setNgl] = useState<number>(typeof flags.ngl === "number" ? flags.ngl : 999);
  const [threads, setThreads] = useState<number>(
    typeof flags.threads === "number" ? flags.threads : 0,
  );
  const [ctx, setCtx] = useState<number>(0);
  const [temp, setTemp] = useState<number>(0.2);
  const [copied, setCopied] = useState(false);
  const [showLog, setShowLog] = useState(false);

  // Tick once a second while running so the elapsed clock advances.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!trRunning) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [trRunning]);

  // Keep the log scrolled to the newest line.
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (showLog && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [trLog, showLog]);

  const mtmd = build?.binaries.find((b) => b.name === "llama-mtmd-cli");
  const mtmdOk = !!mtmd?.ok;

  const promptOk = prompt.trim().length > 0;
  const canRun = !trRunning && mtmdOk && !!buildDir && !!model && !!mmproj && !!audio && promptOk;

  const onTranscribe = () => {
    const args = buildMtmdArgs({
      model,
      mmproj,
      audio,
      prompt: prompt.trim(),
      ngl: Number.isFinite(ngl) ? ngl : null,
      threads: Number.isFinite(threads) ? threads : null,
      ctx: Number.isFinite(ctx) ? ctx : null,
      temp: Number.isFinite(temp) ? temp : null,
    });
    startTranscribe(args).catch(() => {});
  };

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(trOutput);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked — ignore */
    }
  };

  const pick = async (kind: "model" | "mmproj" | "audio") => {
    try {
      if (kind === "audio") {
        const p = await api.pickAudio("Select an audio file");
        if (p) setAudio(p);
      } else {
        const p = await api.pickFile(
          kind === "model" ? "Select model GGUF" : "Select audio projector (mmproj) GGUF",
          ["gguf"],
        );
        if (p) (kind === "model" ? setModel : setMmproj)(p);
      }
    } catch {
      /* dialog cancelled — ignore */
    }
  };

  const statusBadge = trRunning ? (
    <span className="badge yellow">
      <span className="dot" /> transcribing · {elapsedLabel(trStartedAt, now)}
    </span>
  ) : trError ? (
    <span className="badge red" title={trError}>
      <span className="dot" /> error
    </span>
  ) : trExitCode === 0 && trOutput ? (
    <span className="badge green">
      <span className="dot" /> done
    </span>
  ) : (
    <span className="badge ghost">
      <span className="dot" style={{ background: "var(--muted)" }} /> idle
    </span>
  );

  return (
    <>
      <div className="page-head">
        <div>
          <div className="crumb">Tools / Audio</div>
          <h1>Audio → Text transcription</h1>
        </div>
        <div className="head-meta">{statusBadge}</div>
      </div>

      <div className="page-body">
        {!buildDir ? (
          <div className="tr-banner red">
            <I.Info size={14} />
            <span>
              No llama.cpp build directory set. Pick one on <b>Configure → Binary</b> first.
            </span>
          </div>
        ) : !mtmdOk ? (
          <div className="tr-banner red">
            <I.Info size={14} />
            <span>
              <b>llama-mtmd-cli</b> was not found in the current build{" ("}
              <span className="mono">{build?.resolved_path ?? "?"}</span>
              {
                "). Rebuild llama.cpp with the multimodal tools, or point Configure at a build that includes it."
              }
            </span>
          </div>
        ) : (
          <div className="tr-banner">
            <I.Info size={14} />
            <span>
              Runs <span className="mono">llama-mtmd-cli</span> once per clip — it loads the model
              fresh, so the first run takes a moment. Needs an <b>audio-capable</b> model + its
              audio projector (e.g. Voxtral, Qwen2-Audio, Ultravox).
            </span>
          </div>
        )}

        <div className="panel tr-panel">
          <div className="panel-head">
            <I.Sliders size={13} />
            <span>Inputs</span>
          </div>
          <div className="panel-body tr-form">
            <PathField
              label="Model"
              hint="GGUF"
              value={model}
              placeholder="path to the audio model .gguf"
              onChange={setModel}
              onBrowse={() => pick("model")}
              disabled={trRunning}
            />
            <PathField
              label="Audio projector"
              hint="mmproj GGUF"
              value={mmproj}
              placeholder="path to mmproj-*.gguf (audio adapter)"
              onChange={setMmproj}
              onBrowse={() => pick("mmproj")}
              disabled={trRunning}
            />
            <PathField
              label="Audio file"
              hint={audio ? basename(audio) : "wav / mp3 / flac / ogg / m4a"}
              value={audio}
              placeholder="path to the audio clip to transcribe"
              onChange={setAudio}
              onBrowse={() => pick("audio")}
              disabled={trRunning}
            />

            <div className="tr-field">
              <label htmlFor="tr-prompt">Prompt</label>
              <textarea
                id="tr-prompt"
                className="input"
                rows={2}
                value={prompt}
                placeholder={DEFAULT_PROMPT}
                onChange={(e) => setPrompt(e.target.value)}
                disabled={trRunning}
                style={{ resize: "vertical" }}
              />
            </div>

            <div className="tr-num-row">
              <NumField
                label="GPU layers"
                value={ngl}
                onChange={setNgl}
                disabled={trRunning}
                min={0}
                placeholder="auto"
              />
              <NumField
                label="Threads"
                value={threads}
                onChange={setThreads}
                disabled={trRunning}
                min={0}
                placeholder="auto"
              />
              <NumField
                label="Context (0 = model)"
                value={ctx}
                onChange={setCtx}
                disabled={trRunning}
                min={0}
                step={1024}
                placeholder="model default"
              />
              <NumField
                label="Temperature"
                value={temp}
                onChange={setTemp}
                disabled={trRunning}
                min={0}
                step={0.1}
              />
            </div>

            <div className="tr-actions">
              {trRunning ? (
                <button className="btn" onClick={() => cancelTranscribe().catch(() => {})}>
                  <I.Stop size={12} /> Cancel
                </button>
              ) : (
                <button
                  className="btn primary"
                  onClick={onTranscribe}
                  disabled={!canRun}
                  title={
                    !mtmdOk
                      ? "llama-mtmd-cli not available"
                      : !model || !mmproj
                        ? "Pick a model and audio projector"
                        : !audio
                          ? "Pick an audio file"
                          : !promptOk
                            ? "Enter a prompt"
                            : "Transcribe"
                  }
                >
                  <I.Play size={12} /> Transcribe
                </button>
              )}
              <button
                className="btn ghost"
                onClick={clearTranscribe}
                disabled={trRunning || (!trOutput && trLog.length === 0 && !trError)}
                title="Clear the result and log"
              >
                <I.Refresh size={12} /> Clear
              </button>
            </div>
          </div>
        </div>

        {trError && (
          <div className="tr-banner red">
            <I.Info size={14} />
            <span>{trError}</span>
          </div>
        )}

        <div className="panel tr-panel">
          <div className="panel-head">
            <I.Chat size={13} />
            <span>Transcript</span>
            <div style={{ flex: 1 }} />
            <button
              className="btn ghost"
              onClick={onCopy}
              disabled={!trOutput}
              title="Copy transcript"
            >
              {copied ? <I.Check size={12} /> : <I.Copy size={12} />} {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <div className="panel-body">
            {trOutput ? (
              <div className="tr-output">{trOutput}</div>
            ) : trRunning ? (
              <div className="tr-empty">Loading model and decoding audio…</div>
            ) : (
              <div className="tr-empty">The transcript will appear here.</div>
            )}
          </div>
        </div>

        <div className="panel tr-panel">
          <div
            className="panel-head"
            role="button"
            tabIndex={0}
            style={{ cursor: "pointer" }}
            onClick={() => setShowLog((v) => !v)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setShowLog((v) => !v);
              }
            }}
          >
            <I.Terminal size={13} />
            <span>Progress log</span>
            <span className="mono" style={{ color: "var(--subtle)", fontSize: 11 }}>
              {trLog.length} line{trLog.length === 1 ? "" : "s"}
            </span>
            <div style={{ flex: 1 }} />
            <I.Chevron
              size={13}
              style={{
                transform: showLog ? "rotate(180deg)" : undefined,
                transition: "transform .15s",
              }}
            />
          </div>
          {showLog && (
            <div className="panel-body">
              {trLog.length === 0 ? (
                <div className="tr-empty">No output yet.</div>
              ) : (
                <div className="tr-log mono" ref={logRef}>
                  {trLog.map((l, i) => (
                    <div key={i} className="tr-log-line">
                      {l}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
