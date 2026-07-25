import { describe, it, expect, beforeEach, vi } from "vitest";
import { api } from "../../lib/api";
import { buildArgs } from "../../lib/buildArgs";
import { log } from "../../lib/logger";
import { freshStore, makeSettings, stubApi, useAppStore } from "../testUtils";
import {
  activeEngine,
  activeModelLabel,
  argvEqual,
  describeServerExit,
  launchPrereqError,
} from "./serverSlice";

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

describe("server slice — argvEqual (the shared launch-argv comparison)", () => {
  beforeEach(() => {
    freshStore();
    stubApi();
  });

  it("matches element for element", () => {
    expect(argvEqual([], [])).toBe(true);
    expect(argvEqual(["--model", "/m.gguf"], ["--model", "/m.gguf"])).toBe(true);
    expect(argvEqual(["--model", "/a.gguf"], ["--model", "/b.gguf"])).toBe(false);
  });

  it("is order- and length-sensitive — argv position is meaningful", () => {
    expect(argvEqual(["-c", "4096", "-ngl", "99"], ["-ngl", "99", "-c", "4096"])).toBe(false);
    expect(argvEqual(["--fa"], ["--fa", "--fa"])).toBe(false);
  });

  // The Models table and the library overlay render their "loaded" vs "differs
  // from running server" badges from exactly this expression against
  // `loadedArgs`. Now that all three share one implementation, a badge saying
  // "loaded" and reloadIfStale deciding to restart can no longer disagree.
  it("agrees with reloadIfStale about whether a launch is still current", async () => {
    const s = useAppStore.getState();
    s.setSettings(makeSettings({ build_dir: "/b" }));
    s.setFlag("model", "/models/m.gguf");
    await s.startServer(buildArgs(useAppStore.getState().flags));

    const loaded = useAppStore.getState().loadedArgs!;
    expect(argvEqual(buildArgs(useAppStore.getState().flags), loaded)).toBe(true);
    expect(await useAppStore.getState().reloadIfStale()).toBe(true);
    expect(api.stopServer).not.toHaveBeenCalled();

    useAppStore.getState().setFlag("model", "/models/other.gguf");
    expect(argvEqual(buildArgs(useAppStore.getState().flags), loaded)).toBe(false);
  });
});

describe("server slice — hipfire engine dispatch", () => {
  beforeEach(() => {
    freshStore();
    stubApi();
  });

  it("launchPrereqError: hipfire with hipfire_path empty but a tag set has no prereq error", () => {
    // The binary is optional now — it auto-resolves at launch time — so an
    // empty hipfire_path must not block on its own once a tag is set.
    useAppStore.getState().setSettings(
      makeSettings({
        engine_kind: "hipfire",
        hipfire_path: "",
        hipfire_flags: { tag: "qwen3.6:27b" },
      }),
    );
    expect(launchPrereqError(useAppStore.getState)).toBeNull();
  });

  it("launchPrereqError: hipfire with no tag still errors, even with a path set", () => {
    useAppStore
      .getState()
      .setSettings(
        makeSettings({ engine_kind: "hipfire", hipfire_path: "C:/hipfire/hipfire.exe" }),
      );
    expect(launchPrereqError(useAppStore.getState)).toMatch(/tag/i);
  });

  it("startServer proceeds when hipfire_path is empty but a tag is set (binary auto-resolves)", async () => {
    useAppStore.getState().setSettings(
      makeSettings({
        engine_kind: "hipfire",
        hipfire_path: "",
        hipfire_flags: { tag: "qwen3.6:27b" },
      }),
    );
    await useAppStore.getState().startServer(["serve", "qwen3.6:27b", "127.0.0.1:8080"]);
    expect(api.resolveHipfireBin).toHaveBeenCalledWith("");
    expect(api.startServer).toHaveBeenCalledTimes(1);
    const [, , exePath] = vi.mocked(api.startServer).mock.calls[0];
    expect(exePath).toBe("/opt/hipfire/bin/hipfire");
    expect(useAppStore.getState().server.running).toBe(true);
    expect(useAppStore.getState().startError).toBeNull();
  });

  it("startServer surfaces a clear error and never spawns when the hipfire binary can't be resolved", async () => {
    useAppStore.getState().setSettings(
      makeSettings({
        engine_kind: "hipfire",
        hipfire_path: "",
        hipfire_flags: { tag: "qwen3.6:27b" },
      }),
    );
    vi.spyOn(api, "resolveHipfireBin").mockRejectedValueOnce(
      new Error("hipfire not found on PATH — install it or set the binary path in Configure"),
    );
    await useAppStore.getState().startServer(["serve", "qwen3.6:27b", "127.0.0.1:8080"]);
    expect(useAppStore.getState().startError).toMatch(/hipfire not found/i);
    expect(api.startServer).not.toHaveBeenCalled();
  });

  it("startServer blocks when the exe path is set but no tag is configured", async () => {
    useAppStore
      .getState()
      .setSettings(
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

  it("reloadServer refuses to tear down a healthy llama server when hipfire has no tag configured", async () => {
    const s = useAppStore.getState();
    // A healthy llama-server is already running (e.g. adopted, or launched
    // before the toggle flipped).
    s.setSettings(makeSettings({ build_dir: "/b", engine_kind: "hipfire" })); // no tag configured
    s.setServer({
      running: true,
      ready: true,
      info: { pid: 1, port: 8080, started_at: 0, binary: "llama-server" },
    });

    await useAppStore.getState().reloadServer();

    // Critical fix: the running server must NOT have been torn down.
    expect(api.stopServer).not.toHaveBeenCalled();
    expect(api.startServer).not.toHaveBeenCalled();
    expect(useAppStore.getState().startError).toMatch(/tag/i);
    expect(useAppStore.getState().server.running).toBe(true);
  });

  it("reloadServer refuses to tear down a healthy server when the hipfire binary can't be resolved", async () => {
    const s = useAppStore.getState();
    // A tag IS configured (the only sync prereq now), but the binary itself
    // can't be found anywhere — this is the new, async failure mode the
    // binary auto-resolution introduces, and it must get the same
    // before-teardown protection as the sync prereq checks above.
    s.setSettings(
      makeSettings({
        build_dir: "/b",
        engine_kind: "hipfire",
        hipfire_flags: { tag: "qwen3.6:27b" },
      }),
    );
    s.setServer({
      running: true,
      ready: true,
      info: { pid: 1, port: 8080, started_at: 0, binary: "llama-server" },
    });
    vi.spyOn(api, "resolveHipfireBin").mockRejectedValueOnce(
      new Error("hipfire not found on PATH — install it or set the binary path in Configure"),
    );

    await useAppStore.getState().reloadServer();

    // The running server must NOT have been torn down.
    expect(api.stopServer).not.toHaveBeenCalled();
    expect(api.startServer).not.toHaveBeenCalled();
    expect(useAppStore.getState().startError).toMatch(/hipfire not found/i);
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
    expect(useAppStore.getState().startError).toMatch(/tag/i);
  });

  it("reloadIfStale leaves a running server up when a tag is set but the hipfire binary can't be resolved", async () => {
    const s = useAppStore.getState();
    s.setSettings(makeSettings({ build_dir: "/b" }));
    s.setFlag("model", "/models/m.gguf");
    await s.startServer(buildArgs(useAppStore.getState().flags));
    expect(useAppStore.getState().server.running).toBe(true);

    // Toggle to hipfire with a tag configured (passes the sync check) but the
    // binary can't be resolved (fails the async one, one level down inside
    // reloadServer) — the still-healthy llama server must survive either way.
    useAppStore.getState().setSettings({
      ...useAppStore.getState().settings,
      engine_kind: "hipfire",
      hipfire_flags: { tag: "qwen3.6:27b" },
    });
    vi.spyOn(api, "resolveHipfireBin").mockRejectedValueOnce(
      new Error("hipfire not found on PATH — install it or set the binary path in Configure"),
    );
    // reloadServer never touches the running server, so the backend still
    // truthfully reports the untouched old server as running/ready — mirror
    // that here so waitForServerReady's poll reflects reality rather than the
    // suite's default "stopped" stub.
    vi.spyOn(api, "serverStatus").mockResolvedValue({
      running: true,
      ready: true,
      info: { pid: 1, port: 8080, started_at: 0, binary: "llama-server" },
    });

    const ok = await useAppStore.getState().reloadIfStale();

    // reloadServer bailed before stopping anything, so the old server is
    // still running and ready — reloadIfStale reports it usable as-is.
    expect(ok).toBe(true);
    expect(api.stopServer).not.toHaveBeenCalled();
    expect(api.startServer).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().server.running).toBe(true);
    expect(useAppStore.getState().startError).toMatch(/hipfire not found/i);
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
    // buildHipfireArgs always appends --idle-timeout (defaulting to "0" —
    // never unload — when the flag bag doesn't set one; see buildHipfireArgs.test.ts).
    expect(args).toEqual(["serve", "qwen3.6:27b", "127.0.0.1:9090", "--idle-timeout", "0"]);
  });
});

describe("server slice — unexpected exit (DEFECT A regression)", () => {
  beforeEach(() => {
    freshStore();
    stubApi();
  });

  // Put the store in the exact state the bug describes: a server that spawned
  // fine and is still "running, loading the model".
  const launched = async (pid = 4242) => {
    const s = useAppStore.getState();
    s.setSettings(makeSettings({ build_dir: "/b" }));
    s.setFlag("model", "/models/big.gguf");
    vi.mocked(api.startServer).mockResolvedValueOnce({
      pid,
      port: 8080,
      started_at: 1,
      binary: "llama-server",
    });
    await useAppStore.getState().startServer(buildArgs(useAppStore.getState().flags));
    expect(useAppStore.getState().server.running).toBe(true);
    expect(useAppStore.getState().loadedArgs).not.toBeNull();
  };

  it("a crash during model load reverts to stopped AND surfaces the stderr cause", async () => {
    await launched();
    useAppStore.getState().handleServerExit({
      pid: 4242,
      code: 1,
      status: "exit code: 1",
      stderrTail: [
        "llama_model_loader: loaded meta data",
        "llama_model_load: error loading model: unable to allocate CUDA0 buffer",
        "llama_load_model_from_file: failed to load model",
      ],
    });

    const s = useAppStore.getState();
    expect(s.server).toEqual({ running: false, ready: false, info: null });
    // The banner leads with the ROOT cause, not the cascade or the exit code.
    expect(s.startError).toContain("unable to allocate CUDA0 buffer");
    expect(s.startError).toContain("4242");
  });

  it("clears loadedArgs/loadedEngine so reloadIfStale can't diff against a corpse", async () => {
    await launched();
    expect(useAppStore.getState().loadedEngine).toBe("llama");
    useAppStore
      .getState()
      .handleServerExit({ pid: 4242, code: 1, status: "exit code: 1", stderrTail: [] });
    expect(useAppStore.getState().loadedArgs).toBeNull();
    expect(useAppStore.getState().loadedEngine).toBeNull();
  });

  it("fires a user-visible toast — the logs panel is closed by default", async () => {
    await launched();
    const notify = vi.spyOn(log, "notify");
    useAppStore.getState().handleServerExit({
      pid: 4242,
      code: 1,
      status: "exit code: 1",
      stderrTail: ["error: failed to load model"],
    });
    expect(notify).toHaveBeenCalledWith(
      "error",
      "server",
      expect.stringContaining("failed to load model"),
      expect.objectContaining({ pid: 4242, stderr: ["error: failed to load model"] }),
    );
  });

  it("produces a DIFFERENT message on a retry, so a dismissed banner reappears", async () => {
    // Configure's banner hides a message it has had dismissed by exact string
    // equality and never resets it, so two identical failures must not produce
    // two identical strings.
    const tail = ["llama_model_load: error loading model: out of memory"];
    const first = describeServerExit("llama-server", {
      pid: 4242,
      code: 1,
      status: "exit code: 1",
      stderrTail: tail,
    });
    const second = describeServerExit("llama-server", {
      pid: 4243,
      code: 1,
      status: "exit code: 1",
      stderrTail: tail,
    });
    expect(first).not.toBe(second);
  });

  it("still reports a cause when the exit code is unavailable", () => {
    const msg = describeServerExit("llama-server", {
      pid: 7,
      code: null,
      status: "exit status unavailable: handle is invalid",
      stderrTail: ["ggml_vulkan: device lost"],
    });
    expect(msg).toContain("device lost");
    expect(msg).toContain("exit status unavailable");
  });

  it("falls back to a plain message when the process printed nothing", () => {
    const msg = describeServerExit("hipfire", {
      pid: 7,
      code: 3221225477,
      status: "exit code: 3221225477",
      stderrTail: [],
    });
    expect(msg).toContain("hipfire");
    expect(msg).toContain("3221225477");
  });

  it("reports but does not tear down a DIFFERENT, live server", async () => {
    await launched(555);
    // A late crash event for a process the user already replaced.
    useAppStore
      .getState()
      .handleServerExit({ pid: 111, code: 1, status: "exit code: 1", stderrTail: [] });
    const s = useAppStore.getState();
    expect(s.server.running).toBe(true);
    expect(s.server.info?.pid).toBe(555);
    expect(s.loadedArgs).not.toBeNull();
    expect(s.startError).toContain("111");
  });

  it("a user-initiated stop reports nothing — it never reaches handleServerExit", async () => {
    await launched();
    const notify = vi.spyOn(log, "notify");
    await useAppStore.getState().stopServer();
    expect(useAppStore.getState().server).toEqual({ running: false, ready: false, info: null });
    expect(notify).not.toHaveBeenCalled();
  });

  it("probe timeout warns without clearing a server that is still alive", async () => {
    await launched();
    const notify = vi.spyOn(log, "notify");
    useAppStore.getState().handleServerProbeTimeout({
      pid: 4242,
      port: 8080,
      timeoutSecs: 600,
      stderrTail: ["load_tensors: offloading 80 repeating layers to GPU"],
    });
    const s = useAppStore.getState();
    // Alive, so the badge must keep telling the truth.
    expect(s.server.running).toBe(true);
    expect(s.startError).toContain("8080");
    expect(s.startError).toContain("10m");
    expect(notify).toHaveBeenCalledWith("warn", "server", expect.any(String), expect.any(Object));
  });

  it("ignores a probe timeout for a pid that is no longer the running server", async () => {
    await launched(555);
    useAppStore
      .getState()
      .handleServerProbeTimeout({ pid: 111, port: 8080, timeoutSecs: 600, stderrTail: [] });
    expect(useAppStore.getState().startError).toBeNull();
  });

  it("a fresh start clears the previous crash's startError", async () => {
    await launched();
    useAppStore
      .getState()
      .handleServerExit({ pid: 4242, code: 1, status: "exit code: 1", stderrTail: [] });
    expect(useAppStore.getState().startError).not.toBeNull();
    await useAppStore.getState().startServer(["--foo"]);
    expect(useAppStore.getState().startError).toBeNull();
  });

  it("labels the engine as hipfire when that's what was launched", async () => {
    useAppStore.getState().setSettings(
      makeSettings({
        engine_kind: "hipfire",
        hipfire_path: "C:/hipfire/hipfire.exe",
        hipfire_flags: { tag: "qwen3.6:27b" },
      }),
    );
    await useAppStore.getState().startServer(["serve", "qwen3.6:27b", "127.0.0.1:8080"]);
    useAppStore
      .getState()
      .handleServerExit({ pid: 1, code: 1, status: "exit code: 1", stderrTail: [] });
    expect(useAppStore.getState().startError).toContain("hipfire");
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

describe("server slice — activeModelLabel selector", () => {
  beforeEach(() => {
    freshStore();
    stubApi();
  });

  it("llama with a model set returns the full path (caller basenames it)", () => {
    useAppStore.getState().setSettings(makeSettings({ engine_kind: "llama" }));
    useAppStore.getState().setFlag("model", "/models/owner/name/q4.gguf");
    expect(activeModelLabel(useAppStore.getState)).toBe("/models/owner/name/q4.gguf");
  });

  it("llama with no model set returns null", () => {
    useAppStore.getState().setSettings(makeSettings({ engine_kind: "llama" }));
    expect(activeModelLabel(useAppStore.getState)).toBeNull();
  });

  it("hipfire with a tag set returns the tag", () => {
    useAppStore
      .getState()
      .setSettings(makeSettings({ engine_kind: "hipfire", hipfire_flags: { tag: "qwen3.6:27b" } }));
    expect(activeModelLabel(useAppStore.getState)).toBe("qwen3.6:27b");
  });

  it("hipfire with no tag set returns null", () => {
    useAppStore.getState().setSettings(makeSettings({ engine_kind: "hipfire" }));
    expect(activeModelLabel(useAppStore.getState)).toBeNull();
  });

  it("a running hipfire server wins over the toggle flipped to llama", () => {
    useAppStore
      .getState()
      .setSettings(makeSettings({ engine_kind: "llama", hipfire_flags: { tag: "qwen3.6:27b" } }));
    useAppStore.getState().setFlag("model", "/models/should-be-ignored.gguf");
    useAppStore.getState().setServer({
      running: true,
      ready: true,
      info: { pid: 1, port: 8080, started_at: 0, binary: "x" },
    });
    useAppStore.setState({ loadedEngine: "hipfire" });
    expect(activeEngine(useAppStore.getState)).toBe("hipfire");
    expect(activeModelLabel(useAppStore.getState)).toBe("qwen3.6:27b");
  });

  it("a running llama server wins over the toggle flipped to hipfire", () => {
    useAppStore
      .getState()
      .setSettings(
        makeSettings({ engine_kind: "hipfire", hipfire_flags: { tag: "should-be-ignored" } }),
      );
    useAppStore.getState().setFlag("model", "/models/owner/name/q4.gguf");
    useAppStore.getState().setServer({
      running: true,
      ready: true,
      info: { pid: 1, port: 8080, started_at: 0, binary: "x" },
    });
    useAppStore.setState({ loadedEngine: "llama" });
    expect(activeEngine(useAppStore.getState)).toBe("llama");
    expect(activeModelLabel(useAppStore.getState)).toBe("/models/owner/name/q4.gguf");
  });
});
