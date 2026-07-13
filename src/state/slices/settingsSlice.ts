import type { StateCreator } from "zustand";
import { api, type EngineKind, type Settings } from "../../lib/api";
import { persistSettings } from "../persist";
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
  engine_kind: "llama",
  hipfire_path: "",
  hipfire_flags: {},
};

export type SettingsSlice = {
  settings: Settings;
  setSettings: (s: Settings) => void;
  patchSettings: (patch: Partial<Settings>) => Settings;
  clearRecent: () => Promise<void>;
  clearModelsRecent: () => Promise<void>;
  /** Switch the active inference engine ("llama" | "hipfire") and persist. */
  setEngineKind: (kind: EngineKind) => void;
  /** Set the hipfire executable path and persist. */
  setHipfirePath: (path: string) => void;
  /** Set a single hipfire runtime flag (merged into `hipfire_flags`) and persist. */
  setHipfireFlag: (key: string, value: string | number | boolean) => void;
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

  setEngineKind: (kind) => {
    persistSettings(get().patchSettings({ engine_kind: kind }));
  },

  setHipfirePath: (path) => {
    persistSettings(get().patchSettings({ hipfire_path: path }));
  },

  setHipfireFlag: (key, value) => {
    const hipfire_flags = { ...get().settings.hipfire_flags, [key]: value };
    persistSettings(get().patchSettings({ hipfire_flags }));
  },
});

export { persistSettings } from "../persist";
