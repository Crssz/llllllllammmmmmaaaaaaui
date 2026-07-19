import type { StateCreator } from "zustand";
import { api, type HipfireBenchDoneEvent, type HipfireBenchSummary } from "../../lib/api";
import { log } from "../../lib/logger";
import type { AppStore } from "../store";

const PROGRESS_CAP = 200;

/** Live state of the (single) in-flight `hipfire bench` run. Lifted into the
 *  store (hipfirePullSlice's pattern) rather than kept local to BenchScreen:
 *  a bench run can take a while (multiple runs × a prefill sweep) and must
 *  survive the screen unmounting — switching tabs, or just re-rendering —
 *  with Cancel still reachable and the terminal event still handled. */
export type HipfireBenchUi = {
  running: boolean;
  /** Generation id of the in-flight run, used to ignore a stale `hipfire-bench-done`. */
  generation: number | null;
  /** Tag the in-flight run is benchmarking, null when idle. Set synchronously
   *  at start so the "Running…" panel's label can't drift from the tag
   *  actually being measured if the model dropdown is changed (or the screen
   *  remounts) while the run is still in flight — see HipfireResultCard,
   *  which sources its label the same way (from the done event's tag) rather
   *  than live component state. */
  tag: string | null;
  /** Recent raw stdout/stderr lines from `hipfire bench` (capped). */
  lines: string[];
  /** Outcome of the most recently finished run, null until one lands. */
  result: {
    ok: boolean;
    cancelled: boolean;
    error: string | null;
    tag: string;
    output: string;
    summary: HipfireBenchSummary | null;
  } | null;
};

export type HipfireBenchSlice = {
  hipfireBench: HipfireBenchUi;
  hipfireBenchStart: (hipfirePath: string, tag: string, runs: number) => Promise<void>;
  hipfireBenchCancel: () => Promise<void>;
  hipfireBenchOnProgress: (line: string) => void;
  hipfireBenchOnDone: (ev: HipfireBenchDoneEvent) => void;
};

const IDLE: HipfireBenchUi = {
  running: false,
  generation: null,
  tag: null,
  lines: [],
  result: null,
};

export const createHipfireBenchSlice: StateCreator<AppStore, [], [], HipfireBenchSlice> = (
  set,
  get,
) => ({
  hipfireBench: IDLE,

  hipfireBenchStart: async (hipfirePath, tag, runs) => {
    if (get().hipfireBench.running) {
      log.warn("hipfire", "bench start ignored: a benchmark is already running");
      return;
    }
    set({ hipfireBench: { ...IDLE, running: true, tag } });
    log.info("hipfire", `benchmarking ${tag} (${runs} run${runs === 1 ? "" : "s"})`);
    try {
      const generation = await api.runHipfireBench(hipfirePath, tag, runs);
      set((s) => ({ hipfireBench: { ...s.hipfireBench, generation } }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn("hipfire", "bench failed to start", { error: msg });
      set({
        hipfireBench: {
          ...IDLE,
          result: { ok: false, cancelled: false, error: msg, tag, output: "", summary: null },
        },
      });
    }
  },

  hipfireBenchCancel: async () => {
    log.info("hipfire", "bench cancel requested");
    try {
      await api.cancelHipfireBench();
    } catch (e: unknown) {
      log.error("hipfire", "bench cancel failed", { error: String(e) });
    }
  },

  hipfireBenchOnProgress: (line) => {
    if (!get().hipfireBench.running) return;
    set((s) => {
      const lines = [...s.hipfireBench.lines, line];
      if (lines.length > PROGRESS_CAP) lines.splice(0, lines.length - PROGRESS_CAP);
      return { hipfireBench: { ...s.hipfireBench, lines } };
    });
  },

  hipfireBenchOnDone: (ev) => {
    const { generation, running } = get().hipfireBench;
    // Ignore an event for a superseded run (matches hipfirePullOnDone's guard).
    if (running && ev.generation !== generation) {
      log.debug(
        "hipfire",
        `ignoring stale hipfire-bench-done (gen ${ev.generation} != ${generation})`,
      );
      return;
    }

    if (ev.cancelled) {
      log.info("hipfire", "bench cancelled");
      set((s) => ({
        hipfireBench: {
          ...s.hipfireBench,
          running: false,
          result: {
            ok: false,
            cancelled: true,
            error: null,
            tag: ev.tag,
            output: ev.output,
            summary: ev.summary,
          },
        },
      }));
      return;
    }
    if (!ev.ok) {
      const error = ev.error ?? "Benchmark failed.";
      log.error("hipfire", "bench failed", { error, tag: ev.tag });
      set((s) => ({
        hipfireBench: {
          ...s.hipfireBench,
          running: false,
          result: {
            ok: false,
            cancelled: false,
            error,
            tag: ev.tag,
            output: ev.output,
            summary: ev.summary,
          },
        },
      }));
      return;
    }

    log.info("hipfire", `bench done: ${ev.tag}`);
    set((s) => ({
      hipfireBench: {
        ...s.hipfireBench,
        running: false,
        result: {
          ok: true,
          cancelled: false,
          error: null,
          tag: ev.tag,
          output: ev.output,
          summary: ev.summary,
        },
      },
    }));
  },
});
