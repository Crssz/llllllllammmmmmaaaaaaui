// Microphone capture for the Audio → Text screen.
//
// Records mono PCM straight off the mic via the Web Audio API and hands back a
// ready-to-decode WAV (see ./wav). We deliberately do NOT use `MediaRecorder`:
// in WebView2 it only emits Opus/WebM, which `llama-mtmd-cli` can't read. A
// `ScriptProcessorNode` (deprecated but universally supported in the Chromium
// webview) lets us pull raw Float32 frames and encode WAV ourselves.
//
// The AudioContext is opened at 16 kHz — the rate speech encoders want — so the
// captured clip is already small and resample-free. Permission/availability
// failures resolve into a human-readable `error` rather than throwing, and the
// mic is always released (tracks stopped, context closed) on stop, cancel, or
// unmount so the OS recording indicator never lingers.

import { useCallback, useEffect, useRef, useState } from "react";
import { encodeWav } from "./wav";
import { log } from "./logger";

/** Sample rate we open the capture context at. Matches whisper-style encoders. */
const TARGET_SAMPLE_RATE = 16000;
/** ScriptProcessor frame size — ~128 ms at 16 kHz, a smooth meter cadence. */
const FRAME_SIZE = 2048;

export type RecorderState = "idle" | "requesting" | "recording" | "error";

export type Recording = {
  /** Complete WAV byte stream (ArrayBuffer-backed so it's a valid BlobPart). */
  bytes: Uint8Array<ArrayBuffer>;
  durationMs: number;
  sampleRate: number;
};

export type AudioRecorder = {
  state: RecorderState;
  /** Human-readable reason capture is unavailable / failed; null otherwise. */
  error: string | null;
  /** Elapsed capture time in milliseconds (live while recording). */
  durationMs: number;
  /** Peak amplitude of the most recent frame, 0..1 — drives the level meter. */
  level: number;
  start: () => Promise<void>;
  /** Stop and return the encoded clip, or null if nothing was captured. */
  stop: () => Recording | null;
  /** Discard the in-progress capture and release the mic. */
  cancel: () => void;
};

/** Map a getUserMedia rejection to a concise, actionable message. */
function describeMediaError(e: unknown): string {
  const name = e instanceof DOMException ? e.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Microphone access was blocked. Allow this app to use the microphone, then try again.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No microphone was found. Plug one in and try again.";
    case "NotReadableError":
      return "The microphone is busy in another application.";
    default:
      return e instanceof Error ? e.message : String(e);
  }
}

export function useAudioRecorder(): AudioRecorder {
  const [state, setState] = useState<RecorderState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [durationMs, setDurationMs] = useState(0);
  const [level, setLevel] = useState(0);

  // Long-lived capture handles, kept in refs so re-renders don't disturb them.
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sinkRef = useRef<GainNode | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const peakRef = useRef(0);
  const startedAtRef = useRef(0);
  const rateRef = useRef(TARGET_SAMPLE_RATE);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Tear down the whole capture graph and free the microphone. Safe to call
  // multiple times / when nothing is running.
  const teardown = useCallback(() => {
    if (tickRef.current !== null) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    const processor = processorRef.current;
    if (processor) processor.onaudioprocess = null;
    processorRef.current?.disconnect();
    sourceRef.current?.disconnect();
    sinkRef.current?.disconnect();
    processorRef.current = null;
    sourceRef.current = null;
    sinkRef.current = null;
    const ctx = ctxRef.current;
    ctxRef.current = null;
    if (ctx && ctx.state !== "closed") {
      ctx.close().catch(() => {
        /* context already closing — ignore */
      });
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  // Release the mic if the screen unmounts mid-recording.
  useEffect(() => teardown, [teardown]);

  const start = useCallback(async () => {
    if (state === "recording" || state === "requesting") return;
    setError(null);
    setDurationMs(0);
    setLevel(0);
    peakRef.current = 0;
    chunksRef.current = [];

    const media = navigator.mediaDevices;
    if (!media?.getUserMedia) {
      setState("error");
      setError("This build's webview can't access the microphone.");
      return;
    }

    setState("requesting");
    let stream: MediaStream;
    try {
      stream = await media.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (e: unknown) {
      log.warn("mtmd", "microphone request failed", {
        error: e instanceof Error ? e.name || e.message : String(e),
      });
      setState("error");
      setError(describeMediaError(e));
      return;
    }
    streamRef.current = stream;

    // Prefer a 16 kHz context; fall back to the device default if the webview
    // refuses a fixed rate (we record at whatever rate we actually get).
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
    } catch {
      ctx = new AudioContext();
    }
    ctxRef.current = ctx;
    rateRef.current = ctx.sampleRate;
    await ctx.resume().catch(() => {
      /* resume rejects only if already running/closed — ignore */
    });

    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(FRAME_SIZE, 1, 1);
    // A muted sink keeps the node graph connected to the destination (required
    // for onaudioprocess to fire) without echoing the mic to the speakers.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    sourceRef.current = source;
    processorRef.current = processor;
    sinkRef.current = sink;

    processor.onaudioprocess = (ev) => {
      const input = ev.inputBuffer.getChannelData(0);
      // The buffer is reused across callbacks, so copy before stashing.
      chunksRef.current.push(new Float32Array(input));
      let peak = 0;
      for (let i = 0; i < input.length; i++) {
        const amp = Math.abs(input[i]);
        if (amp > peak) peak = amp;
      }
      peakRef.current = peak;
    };

    source.connect(processor);
    processor.connect(sink);
    sink.connect(ctx.destination);

    startedAtRef.current = Date.now();
    setState("recording");
    // Drive the timer + meter off a light interval so capture stays decoupled
    // from React rendering.
    tickRef.current = setInterval(() => {
      setDurationMs(Date.now() - startedAtRef.current);
      setLevel(peakRef.current);
    }, 120);
  }, [state]);

  const stop = useCallback((): Recording | null => {
    if (state !== "recording") return null;
    const chunks = chunksRef.current;
    const sampleRate = rateRef.current;
    const elapsed = Date.now() - startedAtRef.current;
    teardown();
    chunksRef.current = [];
    setState("idle");
    setLevel(0);
    setDurationMs(elapsed);

    let total = 0;
    for (const c of chunks) total += c.length;
    if (total === 0) return null;
    const merged = new Float32Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.length;
    }
    return { bytes: encodeWav(merged, sampleRate), durationMs: elapsed, sampleRate };
  }, [state, teardown]);

  const cancel = useCallback(() => {
    teardown();
    chunksRef.current = [];
    peakRef.current = 0;
    setState("idle");
    setLevel(0);
    setDurationMs(0);
    setError(null);
  }, [teardown]);

  return { state, error, durationMs, level, start, stop, cancel };
}
