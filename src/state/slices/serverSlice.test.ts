import { describe, it, expect, beforeEach, vi } from "vitest";
import { api } from "../../lib/api";
import { buildArgs } from "../../lib/buildArgs";
import { log } from "../../lib/logger";
import { freshStore, makeSettings, stubApi, useAppStore } from "../testUtils";
import { activeEngine } from "./serverSlice";

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

  it("startServer fires a user-visible toast on spawn failure", async () => {
    useAppStore.getState().setSettings(makeSettings({ build_dir: "/b" }));
    vi.spyOn(api, "startServer").mockRejectedValueOnce(new Error("port in use"));
    const notify = vi.spyOn(log, "notify");
    await useAppStore.getState().startServer(["--foo"]);
    expect(notify).toHaveBeenCalledWith("error", "server", expect.stringContaining("port in use"));
  });

  it("startServer toasts the guidance when no build_dir is set", async () => {
    const notify = vi.spyOn(log, "notify");
    await useAppStore.getState().startServer(["--foo"]);
    expect(notify).toHaveBeenCalledWith(
      "warn",
      "server",
      expect.stringMatching(/build directory/i),
    );
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

  it("reloadIfStale reloads when the config changed since the model was loaded", async () => {
    const s = useAppStore.getState();
    s.setSettings(makeSettings({ build_dir: "/b" }));
    s.setFlag("model", "/models/old.gguf");
    // Launch records loadedArgs from the current flags.
    await s.startServer(buildArgs(useAppStore.getState().flags));
    // Backend now reports the reloaded model as ready so the post-reload wait
    // resolves on its first poll.
    vi.spyOn(api, "serverStatus").mockResolvedValue({
      running: true,
      ready: true,
      info: { pid: 2, port: 8080, started_at: 0, binary: "x" },
    });
    // Change a flag → the running server is now serving a stale config.
    s.setFlag("model", "/models/new.gguf");

    const ok = await useAppStore.getState().reloadIfStale();

    expect(ok).toBe(true);
    expect(api.stopServer).toHaveBeenCalledTimes(1);
    // Two starts: the initial launch + the reload with the latest flags.
    expect(api.startServer).toHaveBeenCalledTimes(2);
    const lastArgs = vi.mocked(api.startServer).mock.calls.at(-1)![1];
    expect(lastArgs).toContain("/models/new.gguf");
  });

  it("reloadIfStale is a no-op when the config is unchanged", async () => {
    const s = useAppStore.getState();
    s.setSettings(makeSettings({ build_dir: "/b" }));
    s.setFlag("model", "/models/m.gguf");
    await s.startServer(buildArgs(useAppStore.getState().flags));

    const ok = await useAppStore.getState().reloadIfStale();

    expect(ok).toBe(true);
    expect(api.stopServer).not.toHaveBeenCalled();
    expect(api.startServer).toHaveBeenCalledTimes(1); // just the initial launch
  });

  it("reloadIfStale leaves an adopted server (unknown launch args) alone", async () => {
    const s = useAppStore.getState();
    s.setSettings(makeSettings({ build_dir: "/b" }));
    // Server adopted from a prior app run: running, but we never launched it,
    // so loadedArgs is null and we can't prove it's stale.
    s.setServer({
      running: true,
      ready: true,
      info: { pid: 9, port: 8080, started_at: 0, binary: "x" },
    });
    s.setFlag("model", "/models/whatever.gguf");

    const ok = await useAppStore.getState().reloadIfStale();

    expect(ok).toBe(true);
    expect(api.stopServer).not.toHaveBeenCalled();
    expect(api.startServer).not.toHaveBeenCalled();
  });

  it("setServer replaces server state", () => {
    useAppStore.getState().setServer({
      running: true,
      ready: false,
      info: { pid: 9, port: 80, started_at: 0, binary: "x" },
    });
    expect(useAppStore.getState().server.info?.pid).toBe(9);
  });

  it("startServer records loadedEngine as llama on a plain launch", async () => {
    useAppStore.getState().setSettings(makeSettings({ build_dir: "/b" }));
    await useAppStore.getState().startServer(["--foo"]);
    expect(useAppStore.getState().loadedEngine).toBe("llama");
  });
});

describe("server slice — hipfire engine dispatch", () => {
  beforeEach(() => {
    freshStore();
    stubApi();
  });

  it("startServer blocks with a hipfire-specific hint when the exe path is unset", async () => {
    useAppStore.getState().setSettings(
      makeSettings({ engine_kind: "hipfire", hipfire_flags: { tag: "qwen3.6:27b" } }),
    );
    await useAppStore.getState().startServer(["serve", "qwen3.6:27b", "127.0.0.1:8080"]);
    expect(useAppStore.getState().startError).toMatch(/hipfire executable/i);
    expect(api.startServer).not.toHaveBeenCalled();
  });

  it("startServer blocks when the exe path is set but no tag is configured", async () => {
    useAppStore.getState().setSettings(
      makeSettings({ engine_kind: "hipfire", hipfire_path: "C:/hipfire/hipfire.exe" }),
    );
    await useAppStore.getState().startServer(["serve", "", "127.0.0.1:8080"]);
    expect(useAppStore.getState().startError).toMatch(/tag/i);
    expect(api.startServer).not.toHaveBeenCalled();
  });

  it("startServer passes exePath through to api.startServer and records loadedEngine", async () => {
    useAppStore.getState().setSettings(
      makeSettings({
        engine_kind: "hipfire",
        hipfire_path: "C:/hipfire/hipfire.exe",
        hipfire_flags: { tag: "qwen3.6:27b" },
      }),
    );
    await useAppStore.getState().startServer(["serve", "qwen3.6:27b", "127.0.0.1:8080"]);
    expect(api.startServer).toHaveBeenCalledTimes(1);
    const [, , exePath] = vi.mocked(api.startServer).mock.calls[0];
    expect(exePath).toBe("C:/hipfire/hipfire.exe");
    expect(useAppStore.getState().server.running).toBe(true);
    expect(useAppStore.getState().loadedEngine).toBe("hipfire");
  });

  it("reloadServer refuses to tear down a healthy llama server when hipfire can't launch", async () => {
    const s = useAppStore.getState();
    // A healthy llama-server is already running (e.g. adopted, or launched
    // before the toggle flipped).
    s.setSettings(makeSettings({ build_dir: "/b", engine_kind: "hipfire" })); // no hipfire_path set
    s.setServer({
      running: true,
      ready: true,
      info: { pid: 1, port: 8080, started_at: 0, binary: "llama-server" },
    });

    await useAppStore.getState().reloadServer();

    // Critical fix: the running server must NOT have been torn down.
    expect(api.stopServer).not.toHaveBeenCalled();
    expect(api.startServer).not.toHaveBeenCalled();
    expect(useAppStore.getState().startError).toMatch(/hipfire executable/i);
    expect(useAppStore.getState().server.running).toBe(true);
  });

  it("reloadIfStale refuses to tear down a healthy server when the toggled-to engine can't launch", async () => {
    const s = useAppStore.getState();
    s.setSettings(makeSettings({ build_dir: "/b" }));
    s.setFlag("model", "/models/m.gguf");
    // Launch under llama first so loadedArgs/loadedEngine record a real launch.
    await s.startServer(buildArgs(useAppStore.getState().flags));
    expect(useAppStore.getState().server.running).toBe(true);

    // Flip the toggle to hipfire WITHOUT configuring its prerequisites —
    // activeArgs() now differs from loadedArgs (that's "stale"), but hipfire
    // can't launch, so the existing llama server must be left running.
    useAppStore.getState().setSettings({
      ...useAppStore.getState().settings,
      engine_kind: "hipfire",
    });

    const ok = await useAppStore.getState().reloadIfStale();

    expect(ok).toBe(false);
    expect(api.stopServer).not.toHaveBeenCalled();
    // Only the initial llama launch happened — no doomed hipfire relaunch.
    expect(api.startServer).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().server.running).toBe(true);
    expect(useAppStore.getState().startError).toMatch(/hipfire executable/i);
  });

  it("activeArgs/reloadServer builds hipfire's serve argv when prerequisites are met", async () => {
    useAppStore.getState().setSettings(
      makeSettings({
        engine_kind: "hipfire",
        hipfire_path: "C:/hipfire/hipfire.exe",
        hipfire_flags: { tag: "qwen3.6:27b", port: 9090 },
      }),
    );
    await useAppStore.getState().reloadServer();
    expect(api.startServer).toHaveBeenCalledTimes(1);
    const [, args] = vi.mocked(api.startServer).mock.calls[0];
    expect(args).toEqual(["serve", "qwen3.6:27b", "127.0.0.1:9090"]);
  });
});

describe("server slice — activeEngine selector (BUG 2 regression)", () => {
  beforeEach(() => {
    freshStore();
    stubApi();
  });

  it("(a) server ready + loadedEngine=null (adopted) + toggle=hipfire resolves to llama, not the toggle", () => {
    useAppStore.getState().setServer({
      running: true,
      ready: true,
      info: { pid: 1, port: 8080, started_at: 0, binary: "x" },
    });
    // loadedEngine stays null — we never launched this server (adopted).
    useAppStore.getState().setSettings(makeSettings({ engine_kind: "hipfire" }));
    expect(useAppStore.getState().loadedEngine).toBeNull();
    expect(activeEngine(useAppStore.getState)).toBe("llama");
  });

  it("(b) server ready + loadedEngine=hipfire resolves to hipfire even if the toggle now reads llama", () => {
    useAppStore.getState().setServer({
      running: true,
      ready: true,
      info: { pid: 1, port: 8080, started_at: 0, binary: "x" },
    });
    useAppStore.setState({ loadedEngine: "hipfire" });
    useAppStore.getState().setSettings(makeSettings({ engine_kind: "llama" }));
    expect(activeEngine(useAppStore.getState)).toBe("hipfire");
  });

  it("(c) no server running defers to the toggle (the next-launch target)", () => {
    expect(useAppStore.getState().server.running).toBe(false);
    useAppStore.getState().setSettings(makeSettings({ engine_kind: "hipfire" }));
    expect(activeEngine(useAppStore.getState)).toBe("hipfire");
  });

  it("server running but not yet ready still defers to the toggle", () => {
    useAppStore.getState().setServer({
      running: true,
      ready: false,
      info: { pid: 1, port: 8080, started_at: 0, binary: "x" },
    });
    useAppStore.setState({ loadedEngine: "hipfire" });
    useAppStore.getState().setSettings(makeSettings({ engine_kind: "llama" }));
    // Not ready yet — a launch we DID start as hipfire is still "not the
    // active server" for shaping purposes until it reports ready.
    expect(activeEngine(useAppStore.getState)).toBe("llama");
  });
});
