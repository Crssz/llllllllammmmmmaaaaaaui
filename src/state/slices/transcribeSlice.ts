import type { StateCreator } from "zustand";
import { api } from "../../lib/api";
import { log } from "../../lib/logger";
import type { AppStore } from "../store";

export type TranscribeParams = {
  /** Path to the audio file (a saved recording or a picked wav/mp3). */
  audioPath: string;
  prompt: string;
  /** Sampling temperature; null/undefined → server default. */
  temperature?: number | null;
  /** Cap on generated tokens; <= 0 / null → server default. */
  maxTokens?: number | null;
};

export type TranscribeSlice = {
  trRunning: boolean;
  trStartedAt: number | null;
  /** Transcript text streamed back from llama-server. */
  trOutput: string;
  trError: string | null;
  /** Abort handle for the in-flight request; null when idle. */
  _trAbort: AbortController | null;

  startTranscribe: (params: TranscribeParams) => Promise<void>;
  cancelTranscribe: () => void;
  clearTranscribe: () => void;
};

export const createTranscribeSlice: StateCreator<AppStore, [], [], TranscribeSlice> = (
  set,
  get,
) => ({
  trRunning: false,
  trStartedAt: null,
  trOutput: "",
  trError: null,
  _trAbort: null,

  // Transcribe by streaming an `input_audio` chat-completion off the running
  // llama-server — mirrors chatSlice.runChatRound. No model reload per clip.
  startTranscribe: async ({ audioPath, prompt, temperature, maxTokens }) => {
    if (get().trRunning) {
      log.warn("transcribe", "start ignored: already running");
      return;
    }
    const { server, settings, loadedEngine } = get();
    // Transcription streams an `input_audio` chat-completion, which hipfire's
    // text-only models can't accept (Phase 0 — TODO(hipfire-verify)) — refuse
    // rather than fail mid-stream. Gate on the engine the RUNNING server was
    // actually launched as (loadedEngine) when one is up and ready, so a
    // Configure toggle that hasn't restarted the server doesn't block a
    // working llama-server. With no server up yet, gate on the engine a fresh
    // launch would use (settings.engine_kind).
    const serverReady = server.running && server.ready && !!server.info;
    const activeEngine = serverReady ? loadedEngine : settings.engine_kind;
    if (activeEngine === "hipfire") {
      const msg = "Transcription requires the llama.cpp engine.";
      log.warn("transcribe", msg);
      set({ trError: msg });
      return;
    }
    if (!server.running || !server.ready || !server.info) {
      set({ trError: "Start llama-server with an audio model + projector on Configure first." });
      return;
    }

    set({ trRunning: true, trOutput: "", trError: null, trStartedAt: Date.now() });

    // Recordings and picked files both arrive as a path; read + base64 here.
    let audio: { data: string; format: string };
    try {
      audio = await api.readAudioBase64(audioPath);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error("transcribe", "read audio failed", { error: msg });
      set({ trRunning: false, trError: msg });
      return;
    }

    const url = `http://127.0.0.1:${server.info.port}/v1/chat/completions`;
    const abort = new AbortController();
    set({ _trAbort: abort });

    const body: Record<string, unknown> = {
      model: "local",
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "input_audio", input_audio: { data: audio.data, format: audio.format } },
          ],
        },
      ],
    };
    if (temperature !== null && temperature !== undefined && temperature >= 0) {
      body.temperature = temperature;
    }
    if (maxTokens !== null && maxTokens !== undefined && maxTokens > 0) {
      body.max_tokens = maxTokens;
    }

    log.info("transcribe", `→ ${url} (${audio.format})`);

    let aborted = false;
    let streamError: string | null = null;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}${errBody ? `: ${errBody}` : ""}`);
      }
      if (!res.body) throw new Error("response has no body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const raw = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          const line = raw.trim();
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const chunk = JSON.parse(payload);
            if (chunk.error) {
              streamError =
                typeof chunk.error === "string"
                  ? chunk.error
                  : chunk.error.message || JSON.stringify(chunk.error);
              continue;
            }
            const delta = chunk.choices?.[0]?.delta ?? {};
            if (typeof delta.content === "string" && delta.content.length > 0) {
              const text = delta.content;
              set((s) => ({ trOutput: s.trOutput + text }));
            }
          } catch {
            // Malformed SSE line — log and skip rather than failing the run.
            log.warn("transcribe", "skipped unparseable SSE line", { line });
          }
        }
      }
    } catch (e: unknown) {
      if ((e as { name?: string })?.name === "AbortError") {
        aborted = true;
        log.info("transcribe", "aborted by user");
      } else {
        streamError = e instanceof Error ? e.message : String(e);
        log.error("transcribe", "request failed", { error: streamError, url });
      }
    } finally {
      set({ trRunning: false, _trAbort: null });
    }

    // Only surface an error when nothing usable came back — a server error that
    // still produced a partial transcript stays visible without an alarm.
    if (!aborted && streamError && !get().trOutput.trim()) {
      set({ trError: streamError });
    }
  },

  cancelTranscribe: () => {
    const abort = get()._trAbort;
    if (abort) {
      log.info("transcribe", "cancel requested");
      abort.abort();
    }
    set({ trRunning: false, _trAbort: null });
  },

  clearTranscribe: () => {
    if (get().trRunning) return;
    set({ trOutput: "", trError: null });
  },
});
