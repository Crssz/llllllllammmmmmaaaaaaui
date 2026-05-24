import type { StateCreator } from "zustand";
import { api } from "../../lib/api";
import { log } from "../../lib/logger";
import type { Agency, FlagValues } from "../types";
import { persistSettings } from "../persist";
import type { AppStore } from "../store";

export type FlagsSlice = {
  flags: FlagValues;
  agency: Agency;
  reasoningEnabled: boolean;
  setReasoningEnabled: (v: boolean) => void;
  setFlag: (key: string, value: string | number | boolean) => void;
  resetFlags: (values: FlagValues) => void;
  setAgency: (a: Agency) => void;
  pickModel: () => Promise<void>;
  loadModelPath: (path: string) => void;
};

export const createFlagsSlice: StateCreator<AppStore, [], [], FlagsSlice> = (set, get) => ({
  flags: {},
  agency: "manual",
  reasoningEnabled: true,

  setReasoningEnabled: (v) => {
    set({ reasoningEnabled: v });
    const updated = { ...get().settings, reasoning_enabled: v };
    get().setSettings(updated);
    persistSettings(updated);
    log.info("chat", `enable_thinking: ${v ? "on" : "off"}`);
  },

  setAgency: (a) => set({ agency: a }),

  setFlag: (key, value) => {
    const next = { ...get().flags, [key]: value };
    set({ flags: next });
    const settings = get().settings;
    if (key === "model" && typeof value === "string") {
      const updated = { ...settings, model_path: value, flags: next };
      get().setSettings(updated);
      persistSettings(updated);
    } else {
      persistSettings({ ...settings, flags: next });
    }
  },

  resetFlags: (values) => {
    set({ flags: values });
    const updated = { ...get().settings, flags: values };
    get().setSettings(updated);
    persistSettings(updated);
  },

  pickModel: async () => {
    const picked = await api.pickFile();
    if (picked) get().setFlag("model", picked);
  },

  loadModelPath: (path) => {
    get().setFlag("model", path);
  },
});
