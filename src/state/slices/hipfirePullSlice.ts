import type { StateCreator } from "zustand";
import { api, type HipfirePullDoneEvent } from "../../lib/api";
import { log } from "../../lib/logger";
import type { AppStore } from "../store";

const PROGRESS_CAP = 200;

/** Live state of the (single) in-flight `hipfire pull`. Lifted into the store
 *  (bench/catalog/engine slices' pattern) rather than kept local to
 *  HipfirePullPanel: a pull is a long-running HuggingFace download (the
 *  catalog includes an 82GB entry) that must survive the panel unmounting —
 *  navigating away, switching engines, or just re-rendering Configure — with
 *  Cancel still reachable and the terminal event still handled. */
export type HipfirePullUi = {
  running: boolean;
  /** Generation id of the in-flight pull, used to ignore a stale `hipfire-pull-done`. */
  generation: number | null;
  /** Recent progress lines from `hipfire pull` (capped). */
  lines: string[];
  /** Outcome of the most recently finished pull, null until one lands. */
  result: { ok: boolean; cancelled: boolean; error: string | null; tag: string } | null;
  /** Bumped after every successful pull so HipfireModelPicker (which lists
   *  locally-registered tags) knows to re-fetch, without owning the model
   *  list itself. */
  modelsVersion: number;
};

export type HipfirePullSlice = {
  hipfirePull: HipfirePullUi;
  hipfirePullStart: (hipfirePath: string, tag: string) => Promise<void>;
  hipfirePullCancel: () => Promise<void>;
  hipfirePullOnProgress: (line: string) => void;
  hipfirePullOnDone: (ev: HipfirePullDoneEvent) => void;
  hipfirePullDismissResult: () => void;
};

const IDLE: HipfirePullUi = {
  running: false,
  generation: null,
  lines: [],
  result: null,
  modelsVersion: 0,
};

export const createHipfirePullSlice: StateCreator<AppStore, [], [], HipfirePullSlice> = (
  set,
  get,
) => ({
  hipfirePull: IDLE,

  hipfirePullStart: async (hipfirePath, tag) => {
    if (get().hipfirePull.running) {
      log.warn("hipfire", "pull start ignored: a pull is already running");
      return;
    }
    set((s) => ({ hipfirePull: { ...IDLE, modelsVersion: s.hipfirePull.modelsVersion, running: true } }));
    log.info("hipfire", `pulling ${tag}`);
    try {
      const generation = await api.hipfirePull(hipfirePath, tag);
      set((s) => ({ hipfirePull: { ...s.hipfirePull, generation } }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn("hipfire", "pull failed to start", { error: msg });
      set((s) => ({
        hipfirePull: {
          ...IDLE,
          modelsVersion: s.hipfirePull.modelsVersion,
          result: { ok: false, cancelled: false, error: msg, tag },
        },
      }));
    }
  },

  hipfirePullCancel: async () => {
    log.info("hipfire", "pull cancel requested");
    try {
      await api.cancelHipfirePull();
    } catch (e: unknown) {
      log.error("hipfire", "pull cancel failed", { error: String(e) });
    }
  },

  hipfirePullOnProgress: (line) => {
    if (!get().hipfirePull.running) return;
    set((s) => {
      const lines = [...s.hipfirePull.lines, line];
      if (lines.length > PROGRESS_CAP) lines.splice(0, lines.length - PROGRESS_CAP);
      return { hipfirePull: { ...s.hipfirePull, lines } };
    });
  },

  hipfirePullOnDone: (ev) => {
    const { generation, running } = get().hipfirePull;
    // Ignore an event for a superseded run (matches benchOnDone's guard).
    if (running && ev.generation !== generation) {
      log.debug("hipfire", `ignoring stale hipfire-pull-done (gen ${ev.generation} != ${generation})`);
      return;
    }

    if (ev.cancelled) {
      log.info("hipfire", "pull cancelled");
      set((s) => ({
        hipfirePull: {
          ...s.hipfirePull,
          running: false,
          result: { ok: false, cancelled: true, error: null, tag: ev.tag },
        },
      }));
      return;
    }
    if (!ev.ok) {
      const error = ev.error ?? "Pull failed.";
      log.error("hipfire", "pull failed", { error, tag: ev.tag });
      set((s) => ({
        hipfirePull: {
          ...s.hipfirePull,
          running: false,
          result: { ok: false, cancelled: false, error, tag: ev.tag },
        },
      }));
      return;
    }

    log.info("hipfire", `pulled ${ev.tag}`);
    set((s) => ({
      hipfirePull: {
        ...s.hipfirePull,
        running: false,
        result: { ok: true, cancelled: false, error: null, tag: ev.tag },
        modelsVersion: s.hipfirePull.modelsVersion + 1,
      },
    }));
    // Auto-fill the serve tag with what was just pulled — but never for a
    // draft/companion model (e.g. "qwen3.6:27b-draft"): those exist to pair
    // with an already-configured target tag for DFlash speculation and are
    // never meant to be served on their own, so silently swapping the active
    // serve tag to one would tear down a healthy target server on the very
    // next reload (serverSlice.reloadIfStale compares against it).
    if (ev.tag.endsWith("-draft")) {
      log.notify("info", "hipfire", `Pulled ${ev.tag} — pick it from the model picker when needed`);
    } else {
      get().setHipfireFlag("tag", ev.tag);
      log.notify("info", "hipfire", `Pulled ${ev.tag} — set as the model to serve`);
    }
  },

  hipfirePullDismissResult: () => set((s) => ({ hipfirePull: { ...s.hipfirePull, result: null } })),
});
