import type { StateCreator } from "zustand";
import { api, type SavedProfile, type Settings } from "../../lib/api";
import type { FlagValues } from "../types";
import type { AppStore } from "../store";

export type ProfilesSlice = {
  saveProfile: (name: string) => Promise<void>;
  loadProfile: (id: string) => void;
  deleteProfile: (id: string) => Promise<void>;
  renameProfile: (id: string, name: string) => Promise<void>;
  duplicateProfile: (id: string) => Promise<void>;
};

function profileId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const createProfilesSlice: StateCreator<AppStore, [], [], ProfilesSlice> = (_set, get) => ({
  saveProfile: async (name) => {
    const { flags, settings } = get();
    const profile: SavedProfile = {
      id: profileId(),
      name: name || "Untitled profile",
      created_at: Date.now(),
      flags: flags as Record<string, unknown>,
      model_path: (flags.model as string) || settings.model_path || null,
    };
    const updated: Settings = {
      ...settings,
      profiles: [profile, ...settings.profiles].slice(0, 50),
    };
    await api.saveSettings(updated);
    get().setSettings(updated);
  },

  loadProfile: (id) => {
    const { settings, flags, resetFlags } = get();
    const p = settings.profiles.find((pr) => pr.id === id);
    if (!p) return;
    const f: FlagValues = { ...flags, ...(p.flags as FlagValues) };
    if (p.model_path) f.model = p.model_path;
    resetFlags(f);
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

  renameProfile: async (id, name) => {
    const { settings } = get();
    if (!settings.profiles.some((p) => p.id === id)) return;
    const updated: Settings = {
      ...settings,
      profiles: settings.profiles.map((p) =>
        p.id === id ? { ...p, name: name || "Untitled profile" } : p,
      ),
    };
    await api.saveSettings(updated);
    get().setSettings(updated);
  },

  duplicateProfile: async (id) => {
    const { settings } = get();
    const src = settings.profiles.find((p) => p.id === id);
    if (!src) return;
    const copy: SavedProfile = {
      ...src,
      id: profileId(),
      name: `${src.name} (copy)`,
      created_at: Date.now(),
      flags: { ...src.flags },
    };
    const updated: Settings = {
      ...settings,
      profiles: [copy, ...settings.profiles].slice(0, 50),
    };
    await api.saveSettings(updated);
    get().setSettings(updated);
  },
});
