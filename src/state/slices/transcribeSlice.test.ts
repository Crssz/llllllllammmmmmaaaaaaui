import { describe, it, expect, beforeEach, vi } from "vitest";
import { api } from "../../lib/api";
import { freshStore, makeSettings, stubApi, useAppStore } from "../testUtils";

describe("transcribe slice", () => {
  beforeEach(() => {
    freshStore();
    stubApi();
  });

  it("startTranscribe errors when no build_dir is set", async () => {
    await useAppStore.getState().startTranscribe(["--model", "/m.gguf"]);
    expect(useAppStore.getState().trError).toMatch(/build directory/i);
    expect(useAppStore.getState().trRunning).toBe(false);
    expect(api.transcribeAudio).not.toHaveBeenCalled();
  });

  it("startTranscribe marks running and records the generation", async () => {
    useAppStore.getState().setSettings(makeSettings({ build_dir: "/b" }));
    vi.spyOn(api, "transcribeAudio").mockResolvedValueOnce({ pid: 42, gen: 5, started_at: 99 });
    await useAppStore.getState().startTranscribe(["--model", "/m.gguf"]);
    const s = useAppStore.getState();
    expect(s.trRunning).toBe(true);
    expect(s.trGen).toBe(5);
    expect(s.trPid).toBe(42);
    expect(s.trError).toBeNull();
  });

  it("startTranscribe surfaces backend errors and clears running", async () => {
    useAppStore.getState().setSettings(makeSettings({ build_dir: "/b" }));
    vi.spyOn(api, "transcribeAudio").mockRejectedValueOnce(new Error("mtmd missing"));
    await useAppStore.getState().startTranscribe(["--model", "/m.gguf"]);
    expect(useAppStore.getState().trRunning).toBe(false);
    expect(useAppStore.getState().trError).toBe("mtmd missing");
  });

  it("accumulates output and log events for the active generation", async () => {
    useAppStore.getState().setSettings(makeSettings({ build_dir: "/b" }));
    vi.spyOn(api, "transcribeAudio").mockResolvedValueOnce({ pid: 1, gen: 3, started_at: 0 });
    await useAppStore.getState().startTranscribe(["--model", "/m.gguf"]);

    const ev = useAppStore.getState()._trOnEvent;
    ev({ gen: 3, kind: "log", text: "loading model", code: null });
    ev({ gen: 3, kind: "output", text: "hello ", code: null });
    ev({ gen: 3, kind: "output", text: "world", code: null });

    const s = useAppStore.getState();
    expect(s.trOutput).toBe("hello world");
    expect(s.trLog).toEqual(["loading model"]);
  });

  it("ignores events from a superseded generation", async () => {
    useAppStore.getState().setSettings(makeSettings({ build_dir: "/b" }));
    vi.spyOn(api, "transcribeAudio").mockResolvedValueOnce({ pid: 1, gen: 2, started_at: 0 });
    await useAppStore.getState().startTranscribe(["--model", "/m.gguf"]);

    const ev = useAppStore.getState()._trOnEvent;
    ev({ gen: 1, kind: "output", text: "stale", code: null }); // old run
    ev({ gen: 2, kind: "output", text: "fresh", code: null });
    expect(useAppStore.getState().trOutput).toBe("fresh");
  });

  it("done with a non-zero code and no output sets an error", async () => {
    useAppStore.getState().setSettings(makeSettings({ build_dir: "/b" }));
    vi.spyOn(api, "transcribeAudio").mockResolvedValueOnce({ pid: 1, gen: 1, started_at: 0 });
    await useAppStore.getState().startTranscribe(["--model", "/m.gguf"]);

    useAppStore.getState()._trOnEvent({ gen: 1, kind: "done", text: "", code: 1 });
    const s = useAppStore.getState();
    expect(s.trRunning).toBe(false);
    expect(s.trExitCode).toBe(1);
    expect(s.trError).toMatch(/code 1/);
  });

  it("done with output keeps the transcript and no error even on non-zero code", async () => {
    useAppStore.getState().setSettings(makeSettings({ build_dir: "/b" }));
    vi.spyOn(api, "transcribeAudio").mockResolvedValueOnce({ pid: 1, gen: 1, started_at: 0 });
    await useAppStore.getState().startTranscribe(["--model", "/m.gguf"]);

    const ev = useAppStore.getState()._trOnEvent;
    ev({ gen: 1, kind: "output", text: "a transcript", code: null });
    ev({ gen: 1, kind: "done", text: "", code: 1 });
    const s = useAppStore.getState();
    expect(s.trError).toBeNull();
    expect(s.trOutput).toBe("a transcript");
  });

  it("cancelTranscribe bumps the generation so late events are dropped", async () => {
    useAppStore.getState().setSettings(makeSettings({ build_dir: "/b" }));
    vi.spyOn(api, "transcribeAudio").mockResolvedValueOnce({ pid: 1, gen: 4, started_at: 0 });
    await useAppStore.getState().startTranscribe(["--model", "/m.gguf"]);

    await useAppStore.getState().cancelTranscribe();
    expect(api.cancelTranscribe).toHaveBeenCalled();
    expect(useAppStore.getState().trRunning).toBe(false);
    // An event for the cancelled generation must be ignored.
    useAppStore.getState()._trOnEvent({ gen: 4, kind: "output", text: "late", code: null });
    expect(useAppStore.getState().trOutput).toBe("");
  });

  it("clearTranscribe resets output/log/error when idle", () => {
    useAppStore.setState({
      trOutput: "x",
      trLog: ["l"],
      trError: "e",
      trExitCode: 0,
      trRunning: false,
    });
    useAppStore.getState().clearTranscribe();
    const s = useAppStore.getState();
    expect(s.trOutput).toBe("");
    expect(s.trLog).toEqual([]);
    expect(s.trError).toBeNull();
  });

  it("clearTranscribe is a no-op while running", () => {
    useAppStore.setState({ trOutput: "busy", trRunning: true });
    useAppStore.getState().clearTranscribe();
    expect(useAppStore.getState().trOutput).toBe("busy");
  });
});
