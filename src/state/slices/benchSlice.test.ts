import { describe, it, expect, beforeEach, vi } from "vitest";
import { api, type BenchDoneEvent, type BenchRow } from "../../lib/api";
import { freshStore, makeSettings, stubApi, useAppStore, flush } from "../testUtils";

function row(over: Partial<BenchRow> = {}): BenchRow {
  return {
    model_filename: "m.gguf",
    model_type: "qwen",
    model_size: 0,
    model_n_params: 0,
    build_commit: "",
    test_time: "",
    n_prompt: 512,
    n_gen: 0,
    n_depth: 0,
    n_gpu_layers: -1,
    n_batch: 2048,
    n_ubatch: 512,
    n_threads: 12,
    flash_attn: 1,
    type_k: "f16",
    type_v: "f16",
    avg_ns: 1_000_000,
    stddev_ns: 0,
    avg_ts: 100,
    stddev_ts: 0,
    ...over,
  };
}

function done(over: Partial<BenchDoneEvent> = {}): BenchDoneEvent {
  return { generation: 1, ok: true, cancelled: false, error: null, rows: [row()], ...over };
}

const REQ = {
  model: "/models/m.gguf",
  n_prompt: "512",
  n_gen: "128",
  n_gpu_layers: "999",
  threads: "",
  batch: "2048",
  ubatch: "",
  flash_attn: "on",
  reps: 3,
  extra: [],
};

describe("bench slice", () => {
  beforeEach(() => {
    freshStore();
    stubApi();
  });

  it("benchStart marks running and captures the generation", async () => {
    const s = useAppStore.getState();
    s.setSettings(makeSettings({ build_dir: "/b" }));
    await s.benchStart("/b", REQ, "my run");
    await flush();
    const b = useAppStore.getState();
    expect(b.bench.running).toBe(true);
    expect(b.bench.generation).toBe(1);
    expect(b.benchPending).toEqual({ model: "/models/m.gguf", label: "my run" });
    expect(api.runBench).toHaveBeenCalledWith("/b", REQ);
  });

  it("benchStart surfaces a backend error and clears running", async () => {
    vi.spyOn(api, "runBench").mockRejectedValueOnce(new Error("already running"));
    await useAppStore.getState().benchStart("/b", REQ, "x");
    const b = useAppStore.getState();
    expect(b.bench.running).toBe(false);
    expect(b.bench.error).toBe("already running");
    expect(b.benchPending).toBeNull();
  });

  it("benchOnProgress appends lines only while running", () => {
    // Not running yet — ignored.
    useAppStore.getState().benchOnProgress("ignored");
    expect(useAppStore.getState().bench.progress).toEqual([]);
    useAppStore.setState((s) => ({ bench: { ...s.bench, running: true } }));
    useAppStore.getState().benchOnProgress("line 1");
    useAppStore.getState().benchOnProgress("line 2");
    expect(useAppStore.getState().bench.progress).toEqual(["line 1", "line 2"]);
  });

  it("benchOnDone success records results and saves a history entry", async () => {
    const s = useAppStore.getState();
    s.setSettings(makeSettings({ build_dir: "/b" }));
    await s.benchStart("/b", REQ, "run A");
    await flush();

    useAppStore.getState().benchOnDone(done({ rows: [row({ avg_ts: 200 })] }));

    const b = useAppStore.getState();
    expect(b.bench.running).toBe(false);
    expect(b.bench.results?.[0].avg_ts).toBe(200);
    expect(b.benchRuns).toHaveLength(1);
    expect(b.benchRuns[0].label).toBe("run A");
    expect(b.benchRuns[0].model_path).toBe("/models/m.gguf");
    expect(b.benchPending).toBeNull();
    expect(api.saveBenchRuns).toHaveBeenCalled();
  });

  it("benchOnDone cancellation does not save a run", async () => {
    const s = useAppStore.getState();
    await s.benchStart("/b", REQ, "x");
    await flush();
    useAppStore.getState().benchOnDone(done({ ok: false, cancelled: true, rows: [] }));
    const b = useAppStore.getState();
    expect(b.bench.running).toBe(false);
    expect(b.bench.error).toMatch(/cancel/i);
    expect(b.benchRuns).toHaveLength(0);
  });

  it("benchOnDone failure surfaces the error and saves nothing", async () => {
    const s = useAppStore.getState();
    await s.benchStart("/b", REQ, "x");
    await flush();
    useAppStore.getState().benchOnDone(done({ ok: false, error: "boom", rows: [] }));
    const b = useAppStore.getState();
    expect(b.bench.running).toBe(false);
    expect(b.bench.error).toBe("boom");
    expect(b.benchRuns).toHaveLength(0);
  });

  it("benchOnDone ignores a stale generation while a newer run is in flight", async () => {
    const s = useAppStore.getState();
    await s.benchStart("/b", REQ, "x");
    await flush();
    // A late event from a previous run (gen 0) must not clear the running flag.
    useAppStore.getState().benchOnDone(done({ generation: 0 }));
    expect(useAppStore.getState().bench.running).toBe(true);
    expect(useAppStore.getState().benchRuns).toHaveLength(0);
  });

  it("benchDeleteRun removes a run and clears the viewing selection", async () => {
    const s = useAppStore.getState();
    await s.benchStart("/b", REQ, "x");
    await flush();
    useAppStore.getState().benchOnDone(done());
    const id = useAppStore.getState().benchRuns[0].id;
    useAppStore.getState().benchSelectRun(id);
    expect(useAppStore.getState().benchViewingId).toBe(id);

    useAppStore.getState().benchDeleteRun(id);
    const b = useAppStore.getState();
    expect(b.benchRuns).toHaveLength(0);
    expect(b.benchViewingId).toBeNull();
    expect(api.saveBenchRuns).toHaveBeenCalled();
  });
});
