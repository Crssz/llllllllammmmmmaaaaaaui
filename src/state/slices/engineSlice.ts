import type { StateCreator } from "zustand";
import {
  api,
  type EngineAsset,
  type EngineDone,
  type EngineProgress,
  type EngineRelease,
  type InstalledEngine,
} from "../../lib/api";
import { log } from "../../lib/logger";
import type { AppStore } from "../store";

/** Live state of the (single) in-flight engine download. */
export type EngineDownloadUi = {
  generation: number;
  id: string;
  tag: string;
  phase: "download" | "extract" | "scan";
  downloaded: number;
  total: number;
};

export type EngineSlice = {
  /** Releases fetched from GitHub (cached until a manual refresh). */
  engineReleases: EngineRelease[];
  /** Engines downloaded into the local library. */
  installedEngines: InstalledEngine[];
  engineReleasesLoading: boolean;
  engineReleasesError: string | null;
  /** Non-null while a download/extract/scan is in flight. */
  engineDownload: EngineDownloadUi | null;
  /** Last download/delete/activate error, surfaced in the UI. */
  engineError: string | null;
  /** Accelerator filter for the "Available" list. Defaults to Vulkan — the
   *  prebuilt variant that runs on this machine's AMD R9700. */
  engineVariantFilter: string;

  fetchEngineReleases: (force?: boolean) => Promise<void>;
  refreshInstalledEngines: () => Promise<void>;
  startEngineDownload: (asset: EngineAsset, tag: string) => Promise<void>;
  cancelEngineDownload: () => Promise<void>;
  deleteEngine: (id: string) => Promise<void>;
  activateEngine: (path: string) => Promise<void>;
  setEngineVariantFilter: (variant: string) => void;
  engineOnProgress: (ev: EngineProgress) => void;
  engineOnDone: (ev: EngineDone) => void;
};

export const createEngineSlice: StateCreator<AppStore, [], [], EngineSlice> = (set, get) => ({
  engineReleases: [],
  installedEngines: [],
  engineReleasesLoading: false,
  engineReleasesError: null,
  engineDownload: null,
  engineError: null,
  engineVariantFilter: "vulkan",

  fetchEngineReleases: async (force = false) => {
    if (!force && get().engineReleases.length > 0) return;
    set({ engineReleasesLoading: true, engineReleasesError: null });
    log.info("engines", "fetching releases from github");
    try {
      const releases = await api.listEngineReleases();
      set({ engineReleases: releases });
      log.info("engines", `fetched ${releases.length} releases`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error("engines", "fetch releases failed", { error: msg });
      set({ engineReleasesError: msg });
    } finally {
      set({ engineReleasesLoading: false });
    }
  },

  refreshInstalledEngines: async () => {
    try {
      const installed = await api.listInstalledEngines();
      set({ installedEngines: installed });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn("engines", "list installed failed", { error: msg });
      // Surface it — otherwise a transient read failure looks identical to an
      // empty library and the onboarding empty-state misleads the user.
      set({ engineError: `Couldn't read installed engines: ${msg}` });
    }
  },

  startEngineDownload: async (asset, tag) => {
    if (get().engineDownload) {
      log.warn("engines", "download ignored: one is already running");
      return;
    }
    set({
      engineDownload: {
        generation: 0,
        id: asset.id,
        tag,
        phase: "download",
        downloaded: 0,
        total: asset.size,
      },
      engineError: null,
    });
    log.info("engines", `downloading ${asset.name}`, { id: asset.id });
    try {
      const generation = await api.downloadEngine(asset, tag);
      set((s) => (s.engineDownload ? { engineDownload: { ...s.engineDownload, generation } } : {}));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error("engines", "download failed to start", { error: msg });
      set({ engineDownload: null, engineError: msg });
    }
  },

  cancelEngineDownload: async () => {
    log.info("engines", "cancel requested");
    try {
      await api.cancelEngineDownload();
    } catch (e: unknown) {
      log.error("engines", "cancel failed", { error: String(e) });
    }
  },

  deleteEngine: async (id) => {
    try {
      await api.deleteEngine(id);
      log.info("engines", `deleted ${id}`);
      await get().refreshInstalledEngines();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error("engines", "delete failed", { error: msg });
      set({ engineError: msg });
    }
  },

  activateEngine: async (path) => {
    // Reuse the existing build-dir flow: it persists build_dir, refreshes the
    // HIP hint, and rescans. Then re-list so `active` flags update.
    try {
      await get().setBuildDir(path);
      await get().refreshInstalledEngines();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error("engines", "activate failed", { error: msg });
      set({ engineError: msg });
    }
  },

  setEngineVariantFilter: (variant) => set({ engineVariantFilter: variant }),

  engineOnProgress: (ev) => {
    if (!get().engineDownload) return;
    set({
      engineDownload: {
        generation: ev.generation,
        id: ev.id,
        tag: ev.tag,
        phase: ev.phase,
        downloaded: ev.downloaded,
        total: ev.total,
      },
    });
  },

  engineOnDone: (ev) => {
    if (ev.cancelled) {
      // A user-initiated cancel is a normal outcome, not an error — clear the
      // in-flight state silently rather than flashing a red error banner.
      log.info("engines", "download cancelled");
      set({ engineDownload: null, engineError: null });
      return;
    }
    if (!ev.ok) {
      const error = ev.error ?? "Download failed.";
      log.error("engines", "download failed", { error });
      set({ engineDownload: null, engineError: error });
      return;
    }
    log.info("engines", `installed ${ev.id}`);
    set({ engineDownload: null, engineError: null });
    const installed = ev.installed;
    const name = installed?.tag ?? ev.id;
    // "Active" means a working engine is already selected — either an installed
    // engine flagged active, or a manually-configured build dir that detected.
    // Don't hijack a working setup; only auto-activate when nothing works yet
    // (e.g. a first-run user who just downloaded their first engine).
    const hasActiveEngine =
      get().installedEngines.some((e) => e.active) || Boolean(get().build?.detected);
    if (installed && !hasActiveEngine) {
      void get()
        .activateEngine(installed.path)
        .then(() => {
          log.notify("info", "engines", `Engine ${name} installed and activated`);
        })
        .catch(() => {});
    } else {
      log.notify("info", "engines", `Engine ${name} installed — activate it from the Engine tab`);
      void get().refreshInstalledEngines();
    }
  },
});
