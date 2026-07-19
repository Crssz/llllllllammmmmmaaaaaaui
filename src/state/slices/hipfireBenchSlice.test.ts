import { describe, it, expect, beforeEach, vi } from "vitest";
import { api, type HipfireBenchDoneEvent, type HipfireBenchSummary } from "../../lib/api";
import { flush, freshStore, stubApi, useAppStore } from "../testUtils";

function summary(): HipfireBenchSummary {
  return {
    header: {
      model: "qwen3.6-27b.mq4",
      arch: "dim=5120, layers=64",
      gpu: "gfx1201",
      kv_cache: "auto",
      max_seq: "32768",
      vram: "25712 MB loaded",
      runs: "1",
      mode: "standard",
    },
    prefill: [{ label: "pp128", mean: 822.7, min: 822.7, max: 822.7, stdev: 0, ms: 155.6 }],
    summary: [{ label: "Decode", mean: 82, min: 82, max: 82, stdev: 0, ms: null }],
    decode_ms_per_tok: 12.2,
  };
}

function done(over: Partial<HipfireBenchDoneEvent> = {}): HipfireBenchDoneEvent {
  return {
    generation: 1,
    ok: true,
    cancelled: false,
    error: null,
    tag: "qwen3.6:27b",
    output: "hipfire bench\n...",
    summary: summary(),
    ...over,
  };
}

describe("hipfire bench slice", () => {
  beforeEach(() => {
    freshStore();
    stubApi();
  });

  it("hipfireBenchStart marks running and captures the generation", async () => {
    vi.spyOn(api, "runHipfireBench").mockResolvedValue(7);
    await useAppStore.getState().hipfireBenchStart("/hipfire", "qwen3.6:27b", 3);
    const s = useAppStore.getState();
    expect(s.hipfireBench.running).toBe(true);
    expect(s.hipfireBench.generation).toBe(7);
    expect(api.runHipfireBench).toHaveBeenCalledWith("/hipfire", "qwen3.6:27b", 3);
  });

  // Regression: the "Running…" panel's label must read the tag captured at
  // start, not the model dropdown's live value — the dropdown stays editable
  // while a run is in flight and can drift to a different tag mid-run.
  it("hipfireBenchStart records the tag synchronously, before the backend call resolves", () => {
    vi.spyOn(api, "runHipfireBench").mockReturnValue(new Promise(() => {})); // never resolves
    useAppStore
      .getState()
      .hipfireBenchStart("/hipfire", "qwen3.6:27b", 3)
      .catch(() => {});
    expect(useAppStore.getState().hipfireBench.tag).toBe("qwen3.6:27b");
  });

  it("hipfireBenchStart failure clears the tag along with running", async () => {
    vi.spyOn(api, "runHipfireBench").mockRejectedValueOnce(new Error("boom"));
    await useAppStore.getState().hipfireBenchStart("/hipfire", "qwen3.6:27b", 1);
    expect(useAppStore.getState().hipfireBench.tag).toBeNull();
  });

  it("hipfireBenchStart is a no-op while a run is already running", async () => {
    vi.spyOn(api, "runHipfireBench").mockResolvedValue(1);
    await useAppStore.getState().hipfireBenchStart("/hipfire", "a", 1);
    await useAppStore.getState().hipfireBenchStart("/hipfire", "b", 1);
    expect(api.runHipfireBench).toHaveBeenCalledTimes(1);
  });

  it("hipfireBenchStart surfaces a backend error and clears running", async () => {
    vi.spyOn(api, "runHipfireBench").mockRejectedValueOnce(
      new Error("a benchmark is already running"),
    );
    await useAppStore.getState().hipfireBenchStart("/hipfire", "a", 1);
    const s = useAppStore.getState();
    expect(s.hipfireBench.running).toBe(false);
    expect(s.hipfireBench.result).toEqual({
      ok: false,
      cancelled: false,
      error: "a benchmark is already running",
      tag: "a",
      output: "",
      summary: null,
    });
  });

  it("hipfireBenchOnProgress appends lines only while running", () => {
    useAppStore.getState().hipfireBenchOnProgress("ignored");
    expect(useAppStore.getState().hipfireBench.lines).toEqual([]);
    useAppStore.setState((s) => ({ hipfireBench: { ...s.hipfireBench, running: true } }));
    useAppStore.getState().hipfireBenchOnProgress("line 1");
    useAppStore.getState().hipfireBenchOnProgress("line 2");
    expect(useAppStore.getState().hipfireBench.lines).toEqual(["line 1", "line 2"]);
  });

  it("hipfireBenchOnDone success records the result and parsed summary", async () => {
    vi.spyOn(api, "runHipfireBench").mockResolvedValue(1);
    await useAppStore.getState().hipfireBenchStart("/hipfire", "qwen3.6:27b", 1);
    await flush();

    useAppStore.getState().hipfireBenchOnDone(done());

    const s = useAppStore.getState();
    expect(s.hipfireBench.running).toBe(false);
    expect(s.hipfireBench.result?.ok).toBe(true);
    expect(s.hipfireBench.result?.summary).toEqual(summary());
  });

  it("hipfireBenchOnDone cancellation clears running", async () => {
    vi.spyOn(api, "runHipfireBench").mockResolvedValue(1);
    await useAppStore.getState().hipfireBenchStart("/hipfire", "qwen3.6:27b", 1);
    await flush();

    useAppStore
      .getState()
      .hipfireBenchOnDone(done({ ok: false, cancelled: true, error: null, summary: null }));

    const s = useAppStore.getState();
    expect(s.hipfireBench.running).toBe(false);
    expect(s.hipfireBench.result).toEqual({
      ok: false,
      cancelled: true,
      error: null,
      tag: "qwen3.6:27b",
      output: "hipfire bench\n...",
      summary: null,
    });
  });

  it("hipfireBenchOnDone failure surfaces the error", async () => {
    vi.spyOn(api, "runHipfireBench").mockResolvedValue(1);
    await useAppStore.getState().hipfireBenchStart("/hipfire", "qwen3.6:27b", 1);
    await flush();

    useAppStore.getState().hipfireBenchOnDone(done({ ok: false, error: "exited with an error" }));

    const s = useAppStore.getState();
    expect(s.hipfireBench.running).toBe(false);
    expect(s.hipfireBench.result?.error).toBe("exited with an error");
  });

  it("hipfireBenchOnDone ignores a stale generation while a newer run is in flight", async () => {
    vi.spyOn(api, "runHipfireBench").mockResolvedValue(1);
    await useAppStore.getState().hipfireBenchStart("/hipfire", "qwen3.6:27b", 1);
    await flush();
    useAppStore.getState().hipfireBenchOnDone(done({ generation: 0 }));
    expect(useAppStore.getState().hipfireBench.running).toBe(true);
  });

  it("state survives across a fresh mount (the whole point of lifting it into the store)", async () => {
    vi.spyOn(api, "runHipfireBench").mockResolvedValue(1);
    await useAppStore.getState().hipfireBenchStart("/hipfire", "qwen3.6:27b", 3);
    await flush();
    useAppStore.getState().hipfireBenchOnProgress("run 1/3 ...");
    const s = useAppStore.getState();
    expect(s.hipfireBench.running).toBe(true);
    expect(s.hipfireBench.lines).toEqual(["run 1/3 ..."]);
  });
});
