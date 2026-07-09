import { describe, it, expect, beforeEach, vi } from "vitest";
import { api, type EngineDone, type InstalledEngine } from "../../lib/api";
import { log } from "../../lib/logger";
import { flush, freshStore, stubApi, useAppStore } from "../testUtils";

function makeEngine(over: Partial<InstalledEngine> = {}): InstalledEngine {
  return {
    id: "b5000-vulkan-x64",
    path: "/engines/b5000",
    tag: "b5000",
    variant: "vulkan",
    arch: "x64",
    version: "b5000",
    commit: null,
    backend_badges: ["Vulkan"],
    size: "120 MB",
    installed_at: 1,
    active: false,
    ...over,
  };
}

function doneEvent(over: Partial<EngineDone> = {}): EngineDone {
  return {
    generation: 1,
    id: "b5000-vulkan-x64",
    tag: "b5000",
    ok: true,
    cancelled: false,
    error: null,
    installed: makeEngine(),
    ...over,
  };
}

describe("engine slice", () => {
  beforeEach(() => {
    freshStore();
    stubApi();
    vi.spyOn(api, "listInstalledEngines").mockResolvedValue([]);
    vi.spyOn(api, "listEngineReleases").mockResolvedValue([]);
    vi.spyOn(api, "deleteEngine").mockResolvedValue(undefined);
    vi.spyOn(api, "cancelEngineDownload").mockResolvedValue(undefined);
  });

  it("engineOnDone (cancelled) clears state without an error", () => {
    useAppStore.setState({
      engineDownload: {
        generation: 1,
        id: "x",
        tag: "t",
        phase: "download",
        downloaded: 1,
        total: 2,
      },
    });
    useAppStore.getState().engineOnDone(doneEvent({ ok: false, cancelled: true, installed: null }));
    expect(useAppStore.getState().engineDownload).toBeNull();
    expect(useAppStore.getState().engineError).toBeNull();
  });

  it("engineOnDone (failure) surfaces the error", () => {
    useAppStore
      .getState()
      .engineOnDone(doneEvent({ ok: false, cancelled: false, error: "bad zip", installed: null }));
    expect(useAppStore.getState().engineError).toBe("bad zip");
    expect(useAppStore.getState().engineDownload).toBeNull();
  });

  it("engineOnDone auto-activates the new engine when nothing is active yet", async () => {
    // Fresh store: no installed engines, no detected build → nothing active.
    const addRecent = vi.spyOn(api, "addRecentDir");
    const notify = vi.spyOn(log, "notify");
    useAppStore.getState().engineOnDone(doneEvent());
    // activateEngine → setBuildDir(path) → addRecentDir(path); flush the chain.
    for (let i = 0; i < 12; i++) await flush();
    expect(addRecent).toHaveBeenCalledWith("/engines/b5000");
    expect(notify).toHaveBeenCalledWith(
      "info",
      "engines",
      expect.stringContaining("installed and activated"),
    );
  });

  it("engineOnDone does not hijack an already-active engine", async () => {
    useAppStore.setState({ installedEngines: [makeEngine({ id: "other", active: true })] });
    const addRecent = vi.spyOn(api, "addRecentDir");
    const notify = vi.spyOn(log, "notify");
    useAppStore.getState().engineOnDone(doneEvent());
    for (let i = 0; i < 6; i++) await flush();
    expect(addRecent).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      "info",
      "engines",
      expect.stringContaining("activate it from the Engine tab"),
    );
  });
});
