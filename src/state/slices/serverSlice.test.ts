import { describe, it, expect, beforeEach, vi } from "vitest";
import { api } from "../../lib/api";
import { freshStore, makeSettings, stubApi, useAppStore } from "../testUtils";

describe("server slice", () => {
  beforeEach(() => {
    freshStore();
    stubApi();
  });

  it("startServer warns if build_dir not set", async () => {
    await useAppStore.getState().startServer(["--foo"]);
    expect(useAppStore.getState().startError).toMatch(/build directory/i);
    expect(useAppStore.getState().server.running).toBe(false);
    expect(api.startServer).not.toHaveBeenCalled();
  });

  it("startServer marks server running but not ready", async () => {
    useAppStore.getState().setSettings(makeSettings({ build_dir: "/b" }));
    await useAppStore.getState().startServer(["--foo"]);
    const s = useAppStore.getState();
    expect(s.server.running).toBe(true);
    expect(s.server.ready).toBe(false);
    expect(s.server.info?.pid).toBe(1);
    expect(s.startError).toBeNull();
  });

  it("startServer surfaces backend errors", async () => {
    useAppStore.getState().setSettings(makeSettings({ build_dir: "/b" }));
    vi.spyOn(api, "startServer").mockRejectedValueOnce(new Error("port in use"));
    await useAppStore.getState().startServer(["--foo"]);
    expect(useAppStore.getState().startError).toBe("port in use");
    expect(useAppStore.getState().server.running).toBe(false);
  });

  it("stopServer resets state even when the backend throws", async () => {
    useAppStore.getState().setServer({
      running: true,
      ready: true,
      info: { pid: 1, port: 1, started_at: 0, binary: "x" },
    });
    vi.spyOn(api, "stopServer").mockRejectedValueOnce(new Error("kaboom"));
    await useAppStore.getState().stopServer();
    expect(useAppStore.getState().server).toEqual({ running: false, ready: false, info: null });
  });

  it("reloadServer restarts a running server with the current model + flags", async () => {
    const s = useAppStore.getState();
    s.setSettings(makeSettings({ build_dir: "/b" }));
    s.setFlag("model", "/models/new.gguf");
    s.setServer({
      running: true,
      ready: true,
      info: { pid: 1, port: 8080, started_at: 0, binary: "x" },
    });

    await useAppStore.getState().reloadServer();

    expect(api.stopServer).toHaveBeenCalledTimes(1);
    expect(api.startServer).toHaveBeenCalledTimes(1);
    const [, args] = vi.mocked(api.startServer).mock.calls[0];
    expect(args).toContain("--model");
    expect(args).toContain("/models/new.gguf");
    expect(useAppStore.getState().server.running).toBe(true);
  });

  it("reloadServer starts a stopped server without calling stop", async () => {
    const s = useAppStore.getState();
    s.setSettings(makeSettings({ build_dir: "/b" }));
    s.setFlag("model", "/models/m.gguf");
    // server is STOPPED by default after freshStore()

    await useAppStore.getState().reloadServer();

    expect(api.stopServer).not.toHaveBeenCalled();
    expect(api.startServer).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().server.running).toBe(true);
  });

  it("setServer replaces server state", () => {
    useAppStore.getState().setServer({
      running: true,
      ready: false,
      info: { pid: 9, port: 80, started_at: 0, binary: "x" },
    });
    expect(useAppStore.getState().server.info?.pid).toBe(9);
  });
});
