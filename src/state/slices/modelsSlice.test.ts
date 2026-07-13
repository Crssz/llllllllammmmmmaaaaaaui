import { describe, it, expect, beforeEach, vi } from "vitest";
import { api } from "../../lib/api";
import { freshStore, makeSettings, stubApi, useAppStore } from "../testUtils";

describe("models slice", () => {
  beforeEach(() => {
    freshStore();
    stubApi();
  });

  it("scanModels populates models on success", async () => {
    await useAppStore.getState().scanModels("/m");
    const s = useAppStore.getState();
    expect(s.models?.path).toBe("/m");
    expect(s.modelsScanning).toBe(false);
    expect(s.modelsScanError).toBeNull();
  });

  it("scanModels surfaces errors", async () => {
    vi.spyOn(api, "scanModels").mockRejectedValueOnce(new Error("nope"));
    await useAppStore.getState().scanModels("/bad");
    expect(useAppStore.getState().modelsScanError).toBe("nope");
  });

  it("stale scan results are discarded", async () => {
    let resolveFirst: (v: never) => void = () => {};
    const first = new Promise((res) => {
      resolveFirst = res as never;
    });
    vi.spyOn(api, "scanModels")
      .mockImplementationOnce(() => first as never)
      .mockResolvedValueOnce({ path: "/b", total_gb: 2, count: 1, owners: 1, tree: [] });
    const p1 = useAppStore.getState().scanModels("/a");
    await useAppStore.getState().scanModels("/b");
    resolveFirst({ path: "/a", total_gb: 9, count: 9, owners: 9, tree: [] } as never);
    await p1;
    expect(useAppStore.getState().models?.path).toBe("/b");
  });

  it("pickModelsDir cancellation is a no-op", async () => {
    vi.spyOn(api, "pickFolder").mockResolvedValueOnce(null);
    await useAppStore.getState().pickModelsDir();
    expect(api.scanModels).not.toHaveBeenCalled();
  });

  it("pickModelsDir cascades to setModelsDir → scan", async () => {
    vi.spyOn(api, "pickFolder").mockResolvedValueOnce("/m");
    vi.spyOn(api, "addRecentModelsDir").mockResolvedValueOnce(makeSettings({ models_dir: "/m" }));
    await useAppStore.getState().pickModelsDir();
    expect(api.scanModels).toHaveBeenCalledWith("/m");
  });

  it("rescanModels respects current models_dir", async () => {
    await useAppStore.getState().rescanModels();
    expect(api.scanModels).not.toHaveBeenCalled();
    useAppStore.getState().setSettings(makeSettings({ models_dir: "/m" }));
    await useAppStore.getState().rescanModels();
    expect(api.scanModels).toHaveBeenCalledWith("/m");
  });

  it("setModelInfo updates both info and error", () => {
    useAppStore.getState().setModelInfo(null, "boom");
    expect(useAppStore.getState().modelInfoError).toBe("boom");
    useAppStore.getState().setModelInfo(
      {
        path: "/m/a.gguf",
        gguf_version: 3,
        tensor_count: 0,
        metadata_count: 0,
        architecture: "qwen",
        general_name: null,
        context_length: null,
        block_count: null,
        mtp_support: true,
        size_gb: 1,
        mmproj_siblings: ["mm.gguf"],
        supports_thinking: false,
        thinking_style: null,
        tensor_types: [],
      },
      null,
    );
    expect(useAppStore.getState().modelInfo?.architecture).toBe("qwen");
    expect(useAppStore.getState().modelInfoError).toBeNull();
  });
});
