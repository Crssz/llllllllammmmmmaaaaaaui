import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { I } from "../icons";
import { useAppStore } from "../state";
import { api } from "../lib/api";
import { useAudioRecorder, type Recording } from "../lib/useAudioRecorder";

const DEFAULT_PROMPT = "Transcribe the spoken audio into text. Output only the transcript.";

function basename(p: string): string {
  if (!p) return "";
  const sep = p.includes("\\") ? "\\" : "/";
  return p.split(sep).pop() || p;
}

/** `M:SS` clock for short recording durations. */
function fmtDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(sec / 60)}:${(sec % 60).toString().padStart(2, "0")}`;
}

function NumField({
  label,
  value,
  onChange,
  disabled,
  step,
  min,
  placeholder,
}: Readonly<{
  label: string;
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  step?: number;
  min?: number;
  placeholder?: string;
}>) {
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

/** Microphone capture control. Surfaces idle / requesting / recording states
 *  and hands the finished clip to the parent, which saves + wires it up. */
function Recorder({
  disabled,
  onClip,
}: Readonly<{
  disabled?: boolean;
  onClip: (clip: Recording) => void;
}>) {
  const rec = useAudioRecorder();

  if (rec.state === "recording" || rec.state === "requesting") {
    const requesting = rec.state === "requesting";
    return (
      <div className="tr-rec live">
        <span className="tr-rec-dot" />
        <span className="tr-rec-time mono">
          {requesting ? "starting…" : fmtDuration(rec.durationMs)}
        </span>
        <div className="tr-level" aria-hidden="true">
          <div className="tr-level-bar" style={{ width: `${Math.min(100, rec.level * 140)}%` }} />
        </div>
        <button
          className="btn primary"
          onClick={() => {
            const clip = rec.stop();
            if (clip) onClip(clip);
          }}
          disabled={requesting}
        >
          <I.Stop size={12} /> Stop
        </button>
        <button className="btn ghost" onClick={rec.cancel} title="Discard recording">
          <I.X size={12} />
        </button>
      </div>
    );
  }

  return (
    <div className="tr-rec">
      <button className="btn" onClick={() => rec.start().catch(() => {})} disabled={disabled}>
        <I.Mic size={12} /> Record
      </button>
      <span className="tr-rec-hint">
        {rec.state === "error" && rec.error ? (
          <span className="tr-rec-err">{rec.error}</span>
        ) : (
          "Capture straight from your microphone — saved as a 16 kHz WAV."
        )}
      </span>
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
    trError,
    trStartedAt,
    startTranscribe,
    cancelTranscribe,
    clearTranscribe,
  } = useAppStore(
    useShallow((s) => ({
      trRunning: s.trRunning,
      trOutput: s.trOutput,
      trError: s.trError,
      trStartedAt: s.trStartedAt,
      startTranscribe: s.startTranscribe,
      cancelTranscribe: s.cancelTranscribe,
      clearTranscribe: s.clearTranscribe,
    })),
  );
  const server = useAppStore((s) => s.server);
  const modelName = useAppStore((s) => basename((s.flags.model as string) || ""));
  const hasMmproj = useAppStore((s) => !!(s.flags.mmproj as string));

  const [audio, setAudio] = useState<string>("");
  const [prompt, setPrompt] = useState<string>(DEFAULT_PROMPT);
  const [temp, setTemp] = useState<number>(0.2);
  const [maxTokens, setMaxTokens] = useState<number>(0);
  const [copied, setCopied] = useState(false);

  // Captured mic clip: playback URL, length, and the saved file path that gets
  // fed to the transcription. Null until the user records something.
  const [recording, setRecording] = useState<{ url: string; ms: number; path: string } | null>(
    null,
  );
  const [savingRec, setSavingRec] = useState(false);
  const [recError, setRecError] = useState<string | null>(null);

  // Free the playback object URL when it's replaced or the screen unmounts.
  useEffect(() => {
    const url = recording?.url;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [recording?.url]);

  // Tick once a second while running so the elapsed clock advances.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!trRunning) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [trRunning]);

  const promptOk = prompt.trim().length > 0;
  const canRun = !trRunning && server.ready && !!audio && promptOk;

  const onTranscribe = () => {
    startTranscribe({
      audioPath: audio,
      prompt: prompt.trim(),
      temperature: Number.isFinite(temp) ? temp : null,
      maxTokens: Number.isFinite(maxTokens) ? maxTokens : null,
    }).catch(() => {});
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

  const pickAudioFile = async () => {
    try {
      const p = await api.pickAudio("Select a wav/mp3 file");
      if (p) setAudio(p);
    } catch {
      /* dialog cancelled — ignore */
    }
  };

  // Persist a fresh recording and point the audio input at it. The clip stays
  // playable even if the save fails, but transcription needs the file on disk.
  const handleClip = (clip: Recording) => {
    setRecError(null);
    setSavingRec(true);
    const url = URL.createObjectURL(new Blob([clip.bytes], { type: "audio/wav" }));
    api
      .saveRecording(clip.bytes)
      .then((path) => {
        setAudio(path);
        setRecording({ url, ms: clip.durationMs, path });
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        setRecording({ url, ms: clip.durationMs, path: "" });
        setRecError(`Couldn't save the recording: ${msg}`);
      })
      .finally(() => setSavingRec(false));
  };

  const clearRecording = () => {
    if (recording?.path && audio === recording.path) setAudio("");
    setRecording(null);
    setRecError(null);
  };

  const statusBadge = trRunning ? (
    <span className="badge yellow">
      <span className="dot" /> transcribing · {elapsedLabel(trStartedAt, now)}
    </span>
  ) : trError ? (
    <span className="badge red" title={trError}>
      <span className="dot" /> error
    </span>
  ) : trOutput ? (
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
        {!server.running ? (
          <div className="tr-banner red">
            <I.Info size={14} />
            <span>
              llama-server isn&apos;t running. Start it on <b>Configure</b> with an{" "}
              <b>audio-capable</b> model + its audio projector (e.g. Gemma 4 E2B/E4B, Voxtral,
              Qwen2-Audio), then transcribe here.
            </span>
          </div>
        ) : !server.ready ? (
          <div className="tr-banner">
            <I.Info size={14} />
            <span>
              Server is still loading the model on{" "}
              <span className="mono">:{server.info?.port}</span>… the Transcribe button enables once
              it&apos;s ready.
            </span>
          </div>
        ) : (
          <div className="tr-banner">
            <I.Info size={14} />
            <span>
              Transcribes through the running server
              {modelName ? (
                <>
                  {" ("}
                  <span className="mono">{modelName}</span>
                  {") "}
                </>
              ) : (
                " "
              )}
              — no per-clip model reload.{" "}
              {!hasMmproj && (
                <b>
                  No audio projector (--mmproj) is configured, so the server may reject audio —
                  start it with one.
                </b>
              )}
            </span>
          </div>
        )}

        <div className="panel tr-panel">
          <div className="panel-head">
            <I.Sliders size={13} />
            <span>Inputs</span>
          </div>
          <div className="panel-body tr-form">
            <div className="tr-field">
              <label>
                Audio
                <span className="tr-hint"> · record from the mic or pick a wav/mp3 file</span>
              </label>
              <Recorder disabled={trRunning || savingRec} onClip={handleClip} />
              <div className="tr-path-row">
                <input
                  className="input mono"
                  value={audio}
                  placeholder="…or paste / browse a wav/mp3 file path"
                  onChange={(e) => setAudio(e.target.value)}
                  disabled={trRunning}
                  spellCheck={false}
                />
                <button
                  className="btn ghost"
                  onClick={pickAudioFile}
                  disabled={trRunning}
                  title="Browse for an audio file"
                >
                  <I.Folder size={12} /> Browse
                </button>
              </div>
              {savingRec && <div className="tr-rec-saving mono">saving recording…</div>}
              {recError && <div className="tr-rec-err">{recError}</div>}
              {recording && (
                <div className="tr-rec-chip">
                  <I.Mic size={12} />
                  <span className="mono">recording.wav</span>
                  <span className="tr-rec-chip-dur mono">{fmtDuration(recording.ms)}</span>
                  <audio className="tr-rec-audio" controls src={recording.url} />
                  <div style={{ flex: 1 }} />
                  <button
                    className="btn ghost"
                    onClick={clearRecording}
                    disabled={trRunning}
                    title="Discard recording"
                  >
                    <I.X size={12} /> Clear
                  </button>
                </div>
              )}
            </div>

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
                label="Temperature"
                value={temp}
                onChange={setTemp}
                disabled={trRunning}
                min={0}
                step={0.1}
              />
              <NumField
                label="Max tokens (0 = ∞)"
                value={maxTokens}
                onChange={setMaxTokens}
                disabled={trRunning}
                min={0}
                step={32}
                placeholder="unbounded"
              />
            </div>

            <div className="tr-actions">
              {trRunning ? (
                <button className="btn" onClick={() => cancelTranscribe()}>
                  <I.Stop size={12} /> Cancel
                </button>
              ) : (
                <button
                  className="btn primary"
                  onClick={onTranscribe}
                  disabled={!canRun}
                  title={
                    !server.running
                      ? "Start llama-server on Configure first"
                      : !server.ready
                        ? "Server is still loading the model"
                        : !audio
                          ? "Record or pick an audio file"
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
                disabled={trRunning || (!trOutput && !trError)}
                title="Clear the transcript"
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
              <div className="tr-empty">Transcribing…</div>
            ) : (
              <div className="tr-empty">The transcript will appear here.</div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
