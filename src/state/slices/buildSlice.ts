import type { StateCreator } from "zustand";
import { api, type BuildInfo } from "../../lib/api";
import { log } from "../../lib/logger";
import type { AppStore } from "../store";

export type BuildSlice = {
  build: BuildInfo | null;
  scanning: boolean;
  scanError: string | null;
  _buildScanToken: string | null;
  scanBuild: (dir: string) => Promise<void>;
  pickBuildDir: () => Promise<void>;
  setBuildDir: (dir: string) => Promise<void>;
  rescan: () => Promise<void>;
};

export const createBuildSlice: StateCreator<AppStore, [], [], BuildSlice> = (set, get) => ({
  build: null,
  scanning: false,
  scanError: null,
  _buildScanToken: null,

  scanBuild: async (dir) => {
    set({ _buildScanToken: dir, scanning: true, scanError: null });
    log.info("scan-build", `scan starting`, { dir });
    try {
      const info = await api.scanBuild(dir);
      if (get()._buildScanToken !== dir) return;
      set({ build: info });
      log.info(
        "scan-build",
        `done: detected=${info.detected} version=${info.version ?? "?"} binaries=${info.binaries.length}`,
        { backends: info.backend_badges, resolved: info.resolved_path },
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error("scan-build", `scan failed`, { error: msg });
      if (get()._buildScanToken === dir) set({ scanError: msg });
    } finally {
      if (get()._buildScanToken === dir) set({ scanning: false });
    }
  },

  pickBuildDir: async () => {
    const picked = await api.pickFolder("Select llama.cpp build directory");
    if (picked) await get().setBuildDir(picked);
  },

  setBuildDir: async (dir) => {
    const next = await api.addRecentDir(dir);
    get().setSettings(next);
    await get().scanBuild(dir);
  },

  rescan: async () => {
    const dir = get().settings.build_dir;
    if (dir) await get().scanBuild(dir);
  },
});
