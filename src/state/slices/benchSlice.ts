import type { StateCreator } from "zustand";
import {
  api,
  type BenchDoneEvent,
  type BenchRequest,
  type BenchRow,
  type BenchRun,
} from "../../lib/api";
import { log } from "../../lib/logger";
import { persistBenchRuns } from "../persist";
import type { AppStore } from "../store";

const PROGRESS_CAP = 200;

function benchRunId(): string {
  return `bench_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export type BenchUi = {
  /** True from the moment a run is accepted until its `bench-done` arrives. */
  running: boolean;
  /** Generation id of the in-flight run, used to ignore stale `bench-done`. */
  generation: number;
  /** Recent stderr lines from llama-bench (capped). */
  progress: string[];
  /** Rows from the most recent live run (null until one completes). */
  results: BenchRow[] | null;
  /** Last error / cancellation message, if any. */
  error: string | null;
};

export type BenchSlice = {
  bench: BenchUi;
  benchRuns: BenchRun[];
  /** Which history run is shown in the results view; null = live results. */
  benchViewingId: string | null;
  /** Context captured at start so `bench-done` can build a history entry. */
  benchPending: { model: string; label: string } | null;

  benchLoadRuns: () => Promise<void>;
  benchStart: (buildDir: string, req: BenchRequest, label: string) => Promise<void>;
  benchCancel: () => Promise<void>;
  benchOnProgress: (line: string) => void;
  benchOnDone: (ev: BenchDoneEvent) => void;
  benchSelectRun: (id: string | null) => void;
  benchDeleteRun: (id: string) => void;
};

const IDLE: BenchUi = {
  running: false,
  generation: 0,
  progress: [],
  results: null,
  error: null,
};

export const createBenchSlice: StateCreator<AppStore, [], [], BenchSlice> = (set, get) => ({
  bench: IDLE,
  benchRuns: [],
  benchViewingId: null,
  benchPending: null,

  benchLoadRuns: async () => {
    try {
      const runs = await api.loadBenchRuns();
      set({ benchRuns: runs });
      log.info("bench", `loaded ${runs.length} saved run${runs.length === 1 ? "" : "s"}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn("bench", "bench runs not loaded (likely first run)", { error: msg });
    }
  },

  benchStart: async (buildDir, req, label) => {
    if (get().bench.running) {
      log.warn("bench", "start ignored: a benchmark is already running");
      return;
    }
    set({
      bench: { ...IDLE, running: true },
      benchPending: { model: req.model, label },
      benchViewingId: null,
    });
    log.info("bench", `starting llama-bench`, { model: req.model, label });
    try {
      const generation = await api.runBench(buildDir, req);
      set((s) => ({ bench: { ...s.bench, generation } }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error("bench", "failed to start", { error: msg });
      set({ bench: { ...IDLE, error: msg }, benchPending: null });
    }
  },

  benchCancel: async () => {
    log.info("bench", "cancel requested");
    try {
      await api.cancelBench();
    } catch (e: unknown) {
      log.error("bench", "cancel failed", { error: String(e) });
    }
  },

  benchOnProgress: (line) => {
    if (!get().bench.running) return;
    set((s) => {
      const progress = [...s.bench.progress, line];
      if (progress.length > PROGRESS_CAP) progress.splice(0, progress.length - PROGRESS_CAP);
      return { bench: { ...s.bench, progress } };
    });
  },

  benchOnDone: (ev) => {
    const { generation, running } = get().bench;
    // Ignore events for a superseded run (e.g. a stale cancel after a restart).
    if (running && ev.generation !== generation) {
      log.debug("bench", `ignoring stale bench-done (gen ${ev.generation} != ${generation})`);
      return;
    }

    if (ev.cancelled) {
      log.info("bench", "benchmark cancelled");
      set((s) => ({
        bench: { ...s.bench, running: false, error: "Cancelled." },
        benchPending: null,
      }));
      return;
    }
    if (!ev.ok || ev.rows.length === 0) {
      const error = ev.error ?? "Benchmark failed.";
      log.error("bench", "benchmark failed", { error });
      set((s) => ({ bench: { ...s.bench, running: false, error }, benchPending: null }));
      return;
    }

    // Success: surface the rows and save a history entry.
    const pending = get().benchPending;
    const run: BenchRun = {
      id: benchRunId(),
      created_at: Date.now(),
      model_path: pending?.model ?? ev.rows[0]?.model_filename ?? "",
      label: pending?.label?.trim() || ev.rows[0]?.model_type || "benchmark",
      rows: ev.rows,
    };
    const runs = [run, ...get().benchRuns].slice(0, 100);
    persistBenchRuns(runs);
    log.info("bench", `benchmark done: ${ev.rows.length} rows · saved as "${run.label}"`);
    set((s) => ({
      bench: { ...s.bench, running: false, results: ev.rows, error: null },
      benchRuns: runs,
      benchPending: null,
      benchViewingId: null,
    }));
  },

  benchSelectRun: (id) => set({ benchViewingId: id }),

  benchDeleteRun: (id) => {
    const runs = get().benchRuns.filter((r) => r.id !== id);
    persistBenchRuns(runs);
    set((s) => ({
      benchRuns: runs,
      benchViewingId: s.benchViewingId === id ? null : s.benchViewingId,
    }));
    log.info("bench", `deleted saved run ${id}`);
  },
});
