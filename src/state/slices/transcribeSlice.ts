import type { StateCreator } from "zustand";
import { api } from "../../lib/api";
import { log } from "../../lib/logger";
import type { AppStore } from "../store";

/** Payload of the backend `mtmd-event`. `kind` discriminates the three phases. */
export type MtmdEvent = {
  gen: number;
  kind: "output" | "log" | "done";
  text: string;
  code: number | null;
};

const MAX_LOG_LINES = 600;

export type TranscribeSlice = {
  /** Generation id of the active run; 0 = nothing has run yet. */
  trGen: number;
  trRunning: boolean;
  trPid: number | null;
  trStartedAt: number | null;
  /** Accumulated stdout — the transcription text. */
  trOutput: string;
  /** stderr progress / error lines (model load, audio encode, failures). */
  trLog: string[];
  trError: string | null;
  trExitCode: number | null;

  startTranscribe: (args: string[]) => Promise<void>;
  cancelTranscribe: () => Promise<void>;
  clearTranscribe: () => void;
  /** Wired to the global `mtmd-event` listener in effects.tsx. */
  _trOnEvent: (e: MtmdEvent) => void;
};

export const createTranscribeSlice: StateCreator<AppStore, [], [], TranscribeSlice> = (
  set,
  get,
) => ({
  trGen: 0,
  trRunning: false,
  trPid: null,
  trStartedAt: null,
  trOutput: "",
  trLog: [],
  trError: null,
  trExitCode: null,

  startTranscribe: async (args) => {
    const buildDir = get().settings.build_dir;
    if (!buildDir) {
      set({ trError: "Pick a llama.cpp build directory on Configure first." });
      return;
    }
    if (get().trRunning) {
      log.warn("mtmd", "start ignored: a transcription is already running");
      return;
    }
    // Reset the canvas for the new run before we know its generation.
    set({
      trRunning: true,
      trOutput: "",
      trLog: [],
      trError: null,
      trExitCode: null,
      trPid: null,
      trStartedAt: null,
    });
    log.info("mtmd", "starting transcription", { build_dir: buildDir, arg_count: args.length });
    log.debug("mtmd", `argv: ${args.join(" ")}`);
    try {
      const started = await api.transcribeAudio(buildDir, args);
      set({
        trGen: started.gen,
        trPid: started.pid,
        trStartedAt: started.started_at,
      });
      log.info("mtmd", `spawned pid=${started.pid} gen=${started.gen}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error("mtmd", "start failed", { error: msg });
      set({ trRunning: false, trError: msg });
    }
  },

  cancelTranscribe: async () => {
    if (!get().trRunning) return;
    log.info("mtmd", "cancel requested");
    // Advance the generation locally so any in-flight events are ignored, and
    // flip running off immediately — the backend won't emit `done` on cancel.
    set((s) => ({ trRunning: false, trGen: s.trGen + 1 }));
    try {
      await api.cancelTranscribe();
    } catch (e: unknown) {
      log.warn("mtmd", "cancel failed", { error: String(e) });
    }
  },

  clearTranscribe: () => {
    if (get().trRunning) return;
    set({ trOutput: "", trLog: [], trError: null, trExitCode: null });
  },

  _trOnEvent: (e) => {
    // Drop events from superseded / cancelled runs.
    if (e.gen !== get().trGen) return;
    if (e.kind === "output") {
      set((s) => ({ trOutput: s.trOutput + e.text }));
    } else if (e.kind === "log") {
      set((s) => {
        const next = s.trLog.length >= MAX_LOG_LINES ? s.trLog.slice(-MAX_LOG_LINES + 1) : s.trLog;
        return { trLog: [...next, e.text] };
      });
    } else if (e.kind === "done") {
      const failed = e.code !== null && e.code !== 0;
      set((s) => ({
        trRunning: false,
        trExitCode: e.code,
        // Only surface an error when nothing was produced; a non-zero code with
        // text usually still carries a usable (if truncated) transcription.
        trError:
          failed && !s.trOutput.trim() ? `llama-mtmd-cli exited with code ${e.code}` : s.trError,
      }));
      log.info("mtmd", `done (exit ${e.code ?? "?"})`);
    }
  },
});
