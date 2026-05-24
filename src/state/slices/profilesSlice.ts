import type { StateCreator } from "zustand";
import { api, type SavedProfile, type Settings } from "../../lib/api";
import type { FlagValues } from "../types";
import type { AppStore } from "../store";

export type ProfilesSlice = {
  saveProfile: (name: string) => Promise<void>;
  loadProfile: (id: string) => void;
  deleteProfile: (id: string) => Promise<void>;
};

export const createProfilesSlice: StateCreator<AppStore, [], [], ProfilesSlice> = (_set, get) => ({
  saveProfile: async (name) => {
    const { flags, settings, agency } = get();
    const profile: SavedProfile = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: name || "Untitled profile",
      created_at: Date.now(),
      flags: flags as Record<string, unknown>,
      model_path: (flags.model as string) || settings.model_path || null,
      agency,
    };
    const updated: Settings = {
      ...settings,
      profiles: [profile, ...settings.profiles].slice(0, 50),
    };
    await api.saveSettings(updated);
    get().setSettings(updated);
  },

  loadProfile: (id) => {
    const { settings, flags, resetFlags, setAgency } = get();
    const p = settings.profiles.find((pr) => pr.id === id);
    if (!p) return;
    const f: FlagValues = { ...flags, ...(p.flags as FlagValues) };
    if (p.model_path) f.model = p.model_path;
    resetFlags(f);
    if (p.agency === "manual" || p.agency === "suggest" || p.agency === "auto") {
      setAgency(p.agency);
    }
  },

  deleteProfile: async (id) => {
    const { settings } = get();
    const updated: Settings = {
      ...settings,
      profiles: settings.profiles.filter((p) => p.id !== id),
    };
    await api.saveSettings(updated);
    get().setSettings(updated);
  },
});
