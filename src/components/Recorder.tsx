// Microphone capture control shared by the Transcribe and Chat screens.
// Surfaces idle / requesting / recording / error states and hands the finished
// WAV clip to the parent via `onClip`. The Transcribe and Chat screens decide
// what to do with the bytes (save to a single file vs. a unique chat clip).

import { I } from "../icons";
import { useAudioRecorder, type Recording } from "../lib/useAudioRecorder";

/** `M:SS` clock for short recording durations. */
function fmtDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(sec / 60)}:${(sec % 60).toString().padStart(2, "0")}`;
}

export function Recorder({
  disabled,
  onClip,
  idleHint = "Capture straight from your microphone — saved as a 16 kHz WAV.",
  compact = false,
}: Readonly<{
  disabled?: boolean;
  onClip: (clip: Recording) => void;
  idleHint?: string;
  /** When true, the idle state collapses to just the Record button (no hint). */
  compact?: boolean;
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
      {!compact && (
        <span className="tr-rec-hint">
          {rec.state === "error" && rec.error ? (
            <span className="tr-rec-err">{rec.error}</span>
          ) : (
            idleHint
          )}
        </span>
      )}
      {compact && rec.state === "error" && rec.error && (
        <span className="tr-rec-err" title={rec.error}>
          mic error
        </span>
      )}
    </div>
  );
}

export { fmtDuration as fmtRecDuration };
