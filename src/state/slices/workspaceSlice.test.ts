import { describe, it, expect, beforeEach } from "vitest";
import { api } from "../../lib/api";
import {
  freshStore,
  makeChat,
  makeSettings,
  makeWorkspace,
  stubApi,
  useAppStore,
} from "../testUtils";

describe("workspace slice", () => {
  beforeEach(() => {
    freshStore();
    stubApi();
  });

  it("createWorkspace adds a new entry, returns its id, and persists", async () => {
    const id = await useAppStore.getState().createWorkspace("Project X");
    const workspaces = useAppStore.getState().settings.workspaces;
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0].id).toBe(id);
    expect(workspaces[0].name).toBe("Project X");
    expect(api.saveSettings).toHaveBeenCalled();
  });

  it("createWorkspace defaults the name when empty", async () => {
    await useAppStore.getState().createWorkspace("");
    expect(useAppStore.getState().settings.workspaces[0].name).toBe("Untitled workspace");
  });

  it("renameWorkspace updates the name by id and persists", async () => {
    useAppStore.getState().setSettings(makeSettings({ workspaces: [makeWorkspace({ id: "w1" })] }));
    await useAppStore.getState().renameWorkspace("w1", "Renamed");
    expect(useAppStore.getState().settings.workspaces[0].name).toBe("Renamed");
    expect(api.saveSettings).toHaveBeenCalled();
  });

  it("updateWorkspaceConfig patches only the targeted workspace's config", async () => {
    useAppStore.getState().setSettings(
      makeSettings({
        workspaces: [makeWorkspace({ id: "w1" }), makeWorkspace({ id: "w2" })],
      }),
    );
    await useAppStore.getState().updateWorkspaceConfig("w1", { system_prompt: "be terse" });
    const workspaces = useAppStore.getState().settings.workspaces;
    expect(workspaces.find((w) => w.id === "w1")?.config.system_prompt).toBe("be terse");
    expect(workspaces.find((w) => w.id === "w2")?.config.system_prompt).toBeNull();
  });

  it("deleteWorkspace removes it, clears workspace_id on member chats, and keeps the chats", async () => {
    useAppStore.getState().setSettings(makeSettings({ workspaces: [makeWorkspace({ id: "w1" })] }));
    useAppStore
      .getState()
      .setChats([
        makeChat({ id: "a", workspace_id: "w1" }),
        makeChat({ id: "b", workspace_id: "w2" }),
      ]);
    await useAppStore.getState().deleteWorkspace("w1");
    expect(useAppStore.getState().settings.workspaces).toHaveLength(0);
    const chats = useAppStore.getState().chats;
    expect(chats).toHaveLength(2);
    expect(chats.find((c) => c.id === "a")?.workspace_id).toBeNull();
    expect(chats.find((c) => c.id === "b")?.workspace_id).toBe("w2");
  });

  it("deleteWorkspace resets currentWorkspaceId if it was the active one", async () => {
    useAppStore.getState().setSettings(makeSettings({ workspaces: [makeWorkspace({ id: "w1" })] }));
    useAppStore.getState().selectWorkspace("w1");
    await useAppStore.getState().deleteWorkspace("w1");
    expect(useAppStore.getState().currentWorkspaceId).toBeNull();
  });

  it("selectWorkspace is a pure sync state setter with no persistence", () => {
    useAppStore.getState().selectWorkspace("w1");
    expect(useAppStore.getState().currentWorkspaceId).toBe("w1");
    expect(api.saveSettings).not.toHaveBeenCalled();
  });
});
