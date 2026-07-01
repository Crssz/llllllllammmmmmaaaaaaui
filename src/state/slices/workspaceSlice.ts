import type { StateCreator } from "zustand";
import { api, makeWorkspace, type ChatSessionConfig, type Settings } from "../../lib/api";
import type { AppStore } from "../store";

export type WorkspaceSlice = {
  /** Which workspace's chats the sidebar is currently filtered to. `null` =
   *  "All chats". UI-only — not persisted (mirrors `currentChatId`). */
  currentWorkspaceId: string | null;

  selectWorkspace: (id: string | null) => void;
  createWorkspace: (name: string) => Promise<string>;
  renameWorkspace: (id: string, name: string) => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;
  updateWorkspaceConfig: (id: string, patch: Partial<ChatSessionConfig>) => Promise<void>;
};

export const createWorkspaceSlice: StateCreator<AppStore, [], [], WorkspaceSlice> = (set, get) => ({
  currentWorkspaceId: null,

  selectWorkspace: (id) => set({ currentWorkspaceId: id }),

  createWorkspace: async (name) => {
    const ws = makeWorkspace(name);
    const settings = get().settings;
    const updated: Settings = { ...settings, workspaces: [ws, ...settings.workspaces] };
    await api.saveSettings(updated);
    get().setSettings(updated);
    return ws.id;
  },

  renameWorkspace: async (id, name) => {
    const settings = get().settings;
    const updated: Settings = {
      ...settings,
      workspaces: settings.workspaces.map((w) =>
        w.id === id ? { ...w, name: name || "Untitled workspace" } : w,
      ),
    };
    await api.saveSettings(updated);
    get().setSettings(updated);
  },

  deleteWorkspace: async (id) => {
    const settings = get().settings;
    const updated: Settings = {
      ...settings,
      workspaces: settings.workspaces.filter((w) => w.id !== id),
    };
    await api.saveSettings(updated);
    get().setSettings(updated);
    get().clearWorkspaceFromChats(id);
    if (get().currentWorkspaceId === id) set({ currentWorkspaceId: null });
  },

  updateWorkspaceConfig: async (id, patch) => {
    const settings = get().settings;
    const updated: Settings = {
      ...settings,
      workspaces: settings.workspaces.map((w) =>
        w.id === id ? { ...w, config: { ...w.config, ...patch } } : w,
      ),
    };
    await api.saveSettings(updated);
    get().setSettings(updated);
  },
});
