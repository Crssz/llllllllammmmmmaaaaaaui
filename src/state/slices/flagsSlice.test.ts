import { describe, it, expect, beforeEach, vi } from "vitest";
import { api } from "../../lib/api";
import { freshStore, flush, makeSettings, stubApi, useAppStore } from "../testUtils";

describe("flags slice", () => {
  beforeEach(() => {
    freshStore();
    stubApi();
  });

  it("setFlag persists settings with the new flag", async () => {
    useAppStore.getState().setFlag("ctx", 4096);
    await flush();
    expect(useAppStore.getState().flags.ctx).toBe(4096);
    expect(api.saveSettings).toHaveBeenCalledTimes(1);
  });

  it("setFlag('model', path) also writes model_path on settings", async () => {
    useAppStore.getState().setFlag("model", "/m/a.gguf");
    await flush();
    expect(useAppStore.getState().settings.model_path).toBe("/m/a.gguf");
    // One persist call inside the model branch (carries both settings+flags).
    expect(api.saveSettings).toHaveBeenCalledTimes(1);
  });

  it("resetFlags replaces flags and persists", async () => {
    useAppStore.getState().resetFlags({ ctx: 2048, ngl: 0 });
    await flush();
    expect(useAppStore.getState().flags).toEqual({ ctx: 2048, ngl: 0 });
    expect(api.saveSettings).toHaveBeenCalled();
  });

  it("setReasoningEnabled flips the bit AND persists", async () => {
    useAppStore.getState().setReasoningEnabled(false);
    await flush();
    expect(useAppStore.getState().reasoningEnabled).toBe(false);
    expect(useAppStore.getState().settings.reasoning_enabled).toBe(false);
    expect(api.saveSettings).toHaveBeenCalled();
  });

  it("pickModel no-ops when the dialog is cancelled", async () => {
    vi.spyOn(api, "pickFile").mockResolvedValueOnce(null);
    await useAppStore.getState().pickModel();
    expect(useAppStore.getState().flags.model).toBeUndefined();
  });

  it("pickModel sets the model flag on success", async () => {
    vi.spyOn(api, "pickFile").mockResolvedValueOnce("/x/m.gguf");
    await useAppStore.getState().pickModel();
    expect(useAppStore.getState().flags.model).toBe("/x/m.gguf");
  });

  it("loadModelPath is an alias for setFlag('model', path)", () => {
    useAppStore.getState().loadModelPath("/y/m.gguf");
    expect(useAppStore.getState().flags.model).toBe("/y/m.gguf");
  });

  it("setFlag without model branch persists current settings + merged flags", async () => {
    useAppStore.getState().setSettings(makeSettings({ build_dir: "/b" }));
    useAppStore.getState().setFlag("ngl", 50);
    await flush();
    const lastCall = (api.saveSettings as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
    expect(lastCall.flags.ngl).toBe(50);
    expect(lastCall.build_dir).toBe("/b");
  });
});
