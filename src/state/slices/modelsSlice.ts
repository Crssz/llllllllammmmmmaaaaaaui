import type { StateCreator } from "zustand";
import { api, type GgufInfo, type ModelsScan } from "../../lib/api";
import { log } from "../../lib/logger";
import type { AppStore } from "../store";

export type ModelsSlice = {
  models: ModelsScan | null;
  modelsScanning: boolean;
  modelsScanError: string | null;
  modelInfo: GgufInfo | null;
  modelInfoError: string | null;
  _modelsScanToken: string | null;
  scanModels: (dir: string) => Promise<void>;
  pickModelsDir: () => Promise<void>;
  setModelsDir: (dir: string) => Promise<void>;
  rescanModels: () => Promise<void>;
  setModelInfo: (info: GgufInfo | null, error: string | null) => void;
};

export const createModelsSlice: StateCreator<AppStore, [], [], ModelsSlice> = (set, get) => ({
  models: null,
  modelsScanning: false,
  modelsScanError: null,
  modelInfo: null,
  modelInfoError: null,
  _modelsScanToken: null,

  scanModels: async (dir) => {
    set({ _modelsScanToken: dir, modelsScanning: true, modelsScanError: null });
    log.info("scan-models", `scan starting`, { dir });
    try {
      const info = await api.scanModels(dir);
      if (get()._modelsScanToken !== dir) return;
      set({ models: info });
      log.info(
        "scan-models",
        `done: owners=${info.owners} models=${info.count} total=${info.total_gb.toFixed(1)} GB`,
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error("scan-models", `scan failed`, { error: msg });
      if (get()._modelsScanToken === dir) set({ modelsScanError: msg });
    } finally {
      if (get()._modelsScanToken === dir) set({ modelsScanning: false });
    }
  },

  pickModelsDir: async () => {
    const picked = await api.pickFolder("Select models directory");
    if (picked) await get().setModelsDir(picked);
  },

  setModelsDir: async (dir) => {
    const next = await api.addRecentModelsDir(dir);
    get().setSettings(next);
    await get().scanModels(dir);
  },

  rescanModels: async () => {
    const dir = get().settings.models_dir;
    if (dir) await get().scanModels(dir);
  },

  setModelInfo: (info, error) => set({ modelInfo: info, modelInfoError: error }),
});
