import { describe, it, expect, beforeEach } from "vitest";
import { api } from "../../lib/api";
import { freshStore, makeSettings, stubApi, useAppStore } from "../testUtils";

describe("settings slice", () => {
  beforeEach(() => {
    freshStore();
    stubApi();
  });

  it("setSettings replaces the entire object", () => {
    const s = makeSettings({ build_dir: "/x" });
    useAppStore.getState().setSettings(s);
    expect(useAppStore.getState().settings).toBe(s);
  });

  it("patchSettings merges fields and returns the merged result", () => {
    useAppStore.getState().setSettings(makeSettings({ model_path: "old" }));
    const out = useAppStore.getState().patchSettings({ model_path: "new" });
    expect(out.model_path).toBe("new");
    expect(useAppStore.getState().settings.model_path).toBe("new");
  });

  it("clearRecent persists and resets recent_dirs", async () => {
    useAppStore.getState().setSettings(makeSettings({ recent_dirs: ["/a"] }));
    await useAppStore.getState().clearRecent();
    expect(useAppStore.getState().settings.recent_dirs).toEqual([]);
    expect(api.saveSettings).toHaveBeenCalledTimes(1);
  });

  it("clearModelsRecent persists and resets models_recent", async () => {
    useAppStore.getState().setSettings(makeSettings({ models_recent: ["/m"] }));
    await useAppStore.getState().clearModelsRecent();
    expect(useAppStore.getState().settings.models_recent).toEqual([]);
    expect(api.saveSettings).toHaveBeenCalledTimes(1);
  });

  it("setEngineKind switches the engine and persists", () => {
    useAppStore.getState().setEngineKind("hipfire");
    expect(useAppStore.getState().settings.engine_kind).toBe("hipfire");
    expect(api.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ engine_kind: "hipfire" }),
    );
  });

  it("setHipfirePath sets the exe path and persists", () => {
    useAppStore.getState().setHipfirePath("C:/hipfire/hipfire.exe");
    expect(useAppStore.getState().settings.hipfire_path).toBe("C:/hipfire/hipfire.exe");
    expect(api.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ hipfire_path: "C:/hipfire/hipfire.exe" }),
    );
  });

  it("setHipfireFlag merges a single key into hipfire_flags without clobbering others", () => {
    useAppStore.getState().setSettings(makeSettings({ hipfire_flags: { tag: "keep" } }));
    useAppStore.getState().setHipfireFlag("port", 9090);
    expect(useAppStore.getState().settings.hipfire_flags).toEqual({ tag: "keep", port: 9090 });
  });
});
