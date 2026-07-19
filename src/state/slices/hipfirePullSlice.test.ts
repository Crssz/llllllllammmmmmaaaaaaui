import { describe, it, expect, beforeEach, vi } from "vitest";
import { api, type HipfirePullDoneEvent } from "../../lib/api";
import { flush, freshStore, stubApi, useAppStore } from "../testUtils";

function done(over: Partial<HipfirePullDoneEvent> = {}): HipfirePullDoneEvent {
  return { generation: 1, ok: true, cancelled: false, error: null, tag: "qwen3.5:4b", ...over };
}

describe("hipfire pull slice", () => {
  beforeEach(() => {
    freshStore();
    stubApi();
  });

  it("hipfirePullStart marks running and captures the generation", async () => {
    vi.spyOn(api, "hipfirePull").mockResolvedValue(7);
    await useAppStore.getState().hipfirePullStart("/hipfire", "qwen3.5:4b");
    const s = useAppStore.getState();
    expect(s.hipfirePull.running).toBe(true);
    expect(s.hipfirePull.generation).toBe(7);
    expect(api.hipfirePull).toHaveBeenCalledWith("/hipfire", "qwen3.5:4b");
  });

  // Regression: a panel rendering the running row (Catalog) must be able to
  // read the pulling tag from the store, not a component-local copy that
  // resets to null if the panel unmounts and remounts mid-pull.
  it("hipfirePullStart records the tag synchronously, before the backend call resolves", () => {
    vi.spyOn(api, "hipfirePull").mockReturnValue(new Promise(() => {})); // never resolves
    useAppStore
      .getState()
      .hipfirePullStart("/hipfire", "qwen3.5:4b")
      .catch(() => {});
    expect(useAppStore.getState().hipfirePull.tag).toBe("qwen3.5:4b");
  });

  it("hipfirePullStart failure clears the tag along with running", async () => {
    vi.spyOn(api, "hipfirePull").mockRejectedValueOnce(new Error("boom"));
    await useAppStore.getState().hipfirePullStart("/hipfire", "qwen3.5:4b");
    expect(useAppStore.getState().hipfirePull.tag).toBeNull();
  });

  it("hipfirePullStart is a no-op while a pull is already running", async () => {
    vi.spyOn(api, "hipfirePull").mockResolvedValue(1);
    await useAppStore.getState().hipfirePullStart("/hipfire", "a");
    await useAppStore.getState().hipfirePullStart("/hipfire", "b");
    expect(api.hipfirePull).toHaveBeenCalledTimes(1);
  });

  it("hipfirePullStart surfaces a backend error and clears running", async () => {
    vi.spyOn(api, "hipfirePull").mockRejectedValueOnce(new Error("a pull is already running"));
    await useAppStore.getState().hipfirePullStart("/hipfire", "a");
    const s = useAppStore.getState();
    expect(s.hipfirePull.running).toBe(false);
    expect(s.hipfirePull.result).toEqual({
      ok: false,
      cancelled: false,
      error: "a pull is already running",
      tag: "a",
    });
  });

  it("hipfirePullOnProgress appends lines only while running", () => {
    useAppStore.getState().hipfirePullOnProgress("ignored");
    expect(useAppStore.getState().hipfirePull.lines).toEqual([]);
    useAppStore.setState((s) => ({ hipfirePull: { ...s.hipfirePull, running: true } }));
    useAppStore.getState().hipfirePullOnProgress("line 1");
    useAppStore.getState().hipfirePullOnProgress("line 2");
    expect(useAppStore.getState().hipfirePull.lines).toEqual(["line 1", "line 2"]);
  });

  it("hipfirePullOnDone success records the result, bumps modelsVersion, and applies the tag", async () => {
    vi.spyOn(api, "hipfirePull").mockResolvedValue(1);
    await useAppStore.getState().hipfirePullStart("/hipfire", "qwen3.5:4b");
    await flush();

    useAppStore.getState().hipfirePullOnDone(done());

    const s = useAppStore.getState();
    expect(s.hipfirePull.running).toBe(false);
    expect(s.hipfirePull.result).toEqual({
      ok: true,
      cancelled: false,
      error: null,
      tag: "qwen3.5:4b",
    });
    expect(s.hipfirePull.modelsVersion).toBe(1);
    expect(s.settings.hipfire_flags.tag).toBe("qwen3.5:4b");
  });

  it("hipfirePullOnDone success does NOT apply a draft tag as the serve tag", async () => {
    vi.spyOn(api, "hipfirePull").mockResolvedValue(1);
    await useAppStore.getState().hipfirePullStart("/hipfire", "qwen3.6:27b-draft");
    await flush();
    useAppStore.getState().setHipfireFlag("tag", "qwen3.6:27b");

    useAppStore.getState().hipfirePullOnDone(done({ tag: "qwen3.6:27b-draft" }));

    const s = useAppStore.getState();
    // The target tag the user was already serving must survive pulling its
    // companion draft — a draft is never meant to be served on its own.
    expect(s.settings.hipfire_flags.tag).toBe("qwen3.6:27b");
    // The local-model picker should still be told to refresh.
    expect(s.hipfirePull.modelsVersion).toBe(1);
  });

  it("hipfirePullOnDone cancellation clears running without touching the serve tag", async () => {
    vi.spyOn(api, "hipfirePull").mockResolvedValue(1);
    await useAppStore.getState().hipfirePullStart("/hipfire", "qwen3.5:4b");
    await flush();
    useAppStore.getState().setHipfireFlag("tag", "existing");

    useAppStore.getState().hipfirePullOnDone(done({ ok: false, cancelled: true, error: null }));

    const s = useAppStore.getState();
    expect(s.hipfirePull.running).toBe(false);
    expect(s.hipfirePull.result).toEqual({
      ok: false,
      cancelled: true,
      error: null,
      tag: "qwen3.5:4b",
    });
    expect(s.settings.hipfire_flags.tag).toBe("existing");
  });

  it("hipfirePullOnDone failure surfaces the error", async () => {
    vi.spyOn(api, "hipfirePull").mockResolvedValue(1);
    await useAppStore.getState().hipfirePullStart("/hipfire", "qwen3.5:4b");
    await flush();

    useAppStore.getState().hipfirePullOnDone(done({ ok: false, error: "network error" }));

    const s = useAppStore.getState();
    expect(s.hipfirePull.running).toBe(false);
    expect(s.hipfirePull.result?.error).toBe("network error");
  });

  it("hipfirePullOnDone ignores a stale generation while a newer pull is in flight", async () => {
    vi.spyOn(api, "hipfirePull").mockResolvedValue(1);
    await useAppStore.getState().hipfirePullStart("/hipfire", "qwen3.5:4b");
    await flush();
    // A late event from a previous run (gen 0) must not clear the running flag.
    useAppStore.getState().hipfirePullOnDone(done({ generation: 0 }));
    expect(useAppStore.getState().hipfirePull.running).toBe(true);
  });

  it("state survives across a fresh mount (the whole point of lifting it into the store)", async () => {
    vi.spyOn(api, "hipfirePull").mockResolvedValue(1);
    await useAppStore.getState().hipfirePullStart("/hipfire", "deepseek-v4-flash");
    await flush();
    useAppStore.getState().hipfirePullOnProgress("downloading 12%…");
    // Simulate Configure unmounting and remounting: reading the store fresh
    // (no component-local state to lose) still shows the in-flight pull.
    const s = useAppStore.getState();
    expect(s.hipfirePull.running).toBe(true);
    expect(s.hipfirePull.lines).toEqual(["downloading 12%…"]);
  });
});
