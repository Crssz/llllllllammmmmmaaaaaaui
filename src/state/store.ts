import { create } from "zustand";
import { createSettingsSlice, type SettingsSlice } from "./slices/settingsSlice";
import { createBuildSlice, type BuildSlice } from "./slices/buildSlice";
import { createServerSlice, type ServerSlice } from "./slices/serverSlice";
import { createFlagsSlice, type FlagsSlice } from "./slices/flagsSlice";
import { createModelsSlice, type ModelsSlice } from "./slices/modelsSlice";
import { createHwSlice, type HwSlice } from "./slices/hwSlice";
import { createChatSlice, type ChatSlice } from "./slices/chatSlice";
import { createMcpSlice, type McpSlice } from "./slices/mcpSlice";
import { createProfilesSlice, type ProfilesSlice } from "./slices/profilesSlice";

export type AppStore = SettingsSlice &
  BuildSlice &
  ServerSlice &
  FlagsSlice &
  ModelsSlice &
  HwSlice &
  ChatSlice &
  McpSlice &
  ProfilesSlice;

export const useAppStore = create<AppStore>()((...a) => ({
  ...createSettingsSlice(...a),
  ...createBuildSlice(...a),
  ...createServerSlice(...a),
  ...createFlagsSlice(...a),
  ...createModelsSlice(...a),
  ...createHwSlice(...a),
  ...createChatSlice(...a),
  ...createMcpSlice(...a),
  ...createProfilesSlice(...a),
}));

// Snapshot of the initial state — used by tests to reset the store between
// runs. Captured after the store is built so it includes the action bindings
// rebuilt by zustand.
const _initialState = useAppStore.getState();

export function resetAppStore() {
  useAppStore.setState(_initialState, true);
}
