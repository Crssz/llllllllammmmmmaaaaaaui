import type { StateCreator } from "zustand";
import { api, type Settings } from "../../lib/api";
import type { AppStore } from "../store";

export const EMPTY_SETTINGS: Settings = {
  build_dir: null,
  recent_dirs: [],
  model_path: null,
  flags: {},
  model_configs: {},
  mmproj_pinned: [],
  models_dir: null,
  models_recent: [],
  profiles: [],
  reasoning_enabled: null,
  mcp_servers: [],
  chat_presets: [],
  workspaces: [],
  hf_token: null,
};

export type SettingsSlice = {
  settings: Settings;
  setSettings: (s: Settings) => void;
  patchSettings: (patch: Partial<Settings>) => Settings;
  clearRecent: () => Promise<void>;
  clearModelsRecent: () => Promise<void>;
};

export const createSettingsSlice: StateCreator<AppStore, [], [], SettingsSlice> = (set, get) => ({
  settings: EMPTY_SETTINGS,

  setSettings: (s) => set({ settings: s }),

  patchSettings: (patch) => {
    const next: Settings = { ...get().settings, ...patch };
    set({ settings: next });
    return next;
  },

  clearRecent: async () => {
    const updated: Settings = { ...get().settings, recent_dirs: [] };
    await api.saveSettings(updated);
    set({ settings: updated });
  },

  clearModelsRecent: async () => {
    const updated: Settings = { ...get().settings, models_recent: [] };
    await api.saveSettings(updated);
    set({ settings: updated });
  },
});

export { persistSettings } from "../persist";
