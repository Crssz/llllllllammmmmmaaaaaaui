import { describe, it, expect, beforeEach, vi } from "vitest";
import { api, type GgufInfo } from "../../lib/api";
import { defaultFlags } from "../../data";
import { freshStore, flush, makeSettings, stubApi, useAppStore } from "../testUtils";

const ggufInfo = (siblings: string[]): GgufInfo => ({
  path: "/m/v.gguf",
  gguf_version: 3,
  tensor_count: 0,
  metadata_count: 0,
  architecture: "llama",
  general_name: null,
  context_length: null,
  mtp_support: false,
  size_gb: 0,
  mmproj_siblings: siblings,
  supports_thinking: false,
  thinking_style: null,
});

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

  it("pickModel no-ops and returns null when the dialog is cancelled", async () => {
    vi.spyOn(api, "pickFile").mockResolvedValueOnce(null);
    const picked = await useAppStore.getState().pickModel();
    expect(picked).toBeNull();
    expect(useAppStore.getState().flags.model).toBeUndefined();
  });

  it("pickModel sets the model flag and returns the path on success", async () => {
    vi.spyOn(api, "pickFile").mockResolvedValueOnce("/x/m.gguf");
    const picked = await useAppStore.getState().pickModel();
    expect(picked).toBe("/x/m.gguf");
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

  // ── Per-model config (LM Studio style auto save/restore) ──────────────────

  it("setFlag auto-saves the active model's config under its path (sans model key)", async () => {
    const s = useAppStore.getState();
    s.setFlag("model", "/m/a.gguf");
    s.setFlag("ctx", 4096);
    await flush();
    const cfg = useAppStore.getState().settings.model_configs["/m/a.gguf"];
    expect(cfg.ctx).toBe(4096);
    // The model path is the map key — it must not be duplicated inside the slot.
    expect(cfg.model).toBeUndefined();
  });

  it("does not write model_configs when no model is loaded", async () => {
    useAppStore.getState().setFlag("ctx", 4096);
    await flush();
    expect(useAppStore.getState().settings.model_configs).toEqual({});
  });

  it("setFlag('model', path) restores that model's saved config", () => {
    useAppStore
      .getState()
      .setSettings(makeSettings({ model_configs: { "/m/b.gguf": { ctx: 1024, ngl: 0 } } }));
    useAppStore.getState().setFlag("model", "/m/b.gguf");
    const flags = useAppStore.getState().flags;
    expect(flags.model).toBe("/m/b.gguf");
    expect(flags.ctx).toBe(1024);
    expect(flags.ngl).toBe(0);
  });

  it("restore falls back to defaults for keys the slot omits (no leak from previous model)", async () => {
    // B's saved slot omits `mmproj`; switching A→B must not carry A's mmproj.
    useAppStore
      .getState()
      .setSettings(makeSettings({ model_configs: { "/m/b.gguf": { ctx: 1024 } } }));
    const s = useAppStore.getState();
    s.setFlag("model", "/m/a.gguf");
    s.setFlag("mmproj", "/A/proj.gguf");
    s.setFlag("model", "/m/b.gguf");
    await flush();
    const st = useAppStore.getState();
    expect(st.flags.mmproj).toBe(defaultFlags().mmproj); // "" — not "/A/proj.gguf"
    // …and the leaked value is not re-persisted into B's slot either.
    expect(st.settings.model_configs["/m/b.gguf"].mmproj).toBe(defaultFlags().mmproj);
  });

  it("switching models swaps in each model's own saved config", () => {
    const s = useAppStore.getState();
    s.setFlag("model", "/m/a.gguf");
    s.setFlag("ctx", 8192);
    s.setFlag("model", "/m/c.gguf");
    s.setFlag("ctx", 2048);
    s.setFlag("model", "/m/a.gguf");
    expect(useAppStore.getState().flags.ctx).toBe(8192);
    s.setFlag("model", "/m/c.gguf");
    expect(useAppStore.getState().flags.ctx).toBe(2048);
  });

  it("loading a model with no saved config seeds its slot from current flags", async () => {
    const s = useAppStore.getState();
    s.setFlag("ctx", 7777);
    s.setFlag("model", "/m/fresh.gguf");
    await flush();
    expect(useAppStore.getState().settings.model_configs["/m/fresh.gguf"].ctx).toBe(7777);
  });

  it("forgetModelConfig resets to defaults and drops the saved slot", async () => {
    const s = useAppStore.getState();
    s.setFlag("model", "/m/a.gguf");
    s.setFlag("ctx", 9999);
    s.forgetModelConfig();
    await flush();
    const st = useAppStore.getState();
    expect(st.flags.model).toBe("/m/a.gguf"); // model stays loaded
    expect(st.flags.ctx).toBe(defaultFlags().ctx); // back to factory default
    expect(st.settings.model_configs["/m/a.gguf"]).toBeUndefined(); // slot dropped
  });

  it("resetFlags maintains the per-model slot for the resulting model", async () => {
    useAppStore.getState().resetFlags({ model: "/m/d.gguf", ctx: 512 });
    await flush();
    const cfg = useAppStore.getState().settings.model_configs["/m/d.gguf"];
    expect(cfg.ctx).toBe(512);
    expect(cfg.model).toBeUndefined();
  });

  it("forgetModelConfig with no model loaded resets flags without touching model_configs or model_path", async () => {
    const s = useAppStore.getState();
    s.setSettings(
      makeSettings({
        model_path: "/m/keep.gguf",
        model_configs: { "/m/unrelated.gguf": { ctx: 1234 } },
      }),
    );
    s.resetFlags({ ctx: 9999 }); // no `model` key → "no model loaded" state
    s.forgetModelConfig();
    await flush();
    const st = useAppStore.getState();
    expect(st.flags.ctx).toBe(defaultFlags().ctx); // reset to factory default
    expect("model" in st.flags).toBe(false); // model key absent, not undefined-valued
    expect(st.settings.model_configs).toEqual({ "/m/unrelated.gguf": { ctx: 1234 } }); // untouched
    expect(st.settings.model_path).toBe("/m/keep.gguf"); // preserved
  });

  // ── mmproj pin: respecting explicit user intent over auto-detect ──────────

  it("setMmproj sets the projector and pins it for the current model", async () => {
    const s = useAppStore.getState();
    s.setFlag("model", "/m/v.gguf");
    s.setMmproj("/m/mmproj-v.gguf");
    await flush();
    const st = useAppStore.getState();
    expect(st.flags.mmproj).toBe("/m/mmproj-v.gguf");
    expect(st.settings.mmproj_pinned).toContain("/m/v.gguf");
    expect(st.settings.model_configs["/m/v.gguf"].mmproj).toBe("/m/mmproj-v.gguf");
  });

  it("setMmproj('') pins a deliberately text-only model", async () => {
    const s = useAppStore.getState();
    s.setFlag("model", "/m/v.gguf");
    s.setMmproj("");
    await flush();
    expect(useAppStore.getState().settings.mmproj_pinned).toContain("/m/v.gguf");
  });

  it("autoDetectMmproj fills a sibling for an unpinned model", () => {
    const s = useAppStore.getState();
    s.setFlag("model", "/m/v.gguf");
    s.setModelInfo(ggufInfo(["/m/mmproj-v.gguf"]), null);
    s.autoDetectMmproj();
    expect(useAppStore.getState().flags.mmproj).toBe("/m/mmproj-v.gguf");
  });

  it("autoDetectMmproj leaves a pinned model's projector alone (deliberate clear sticks)", () => {
    const s = useAppStore.getState();
    s.setFlag("model", "/m/v.gguf");
    s.setMmproj(""); // user runs the vision model text-only
    s.setModelInfo(ggufInfo(["/m/mmproj-v.gguf"]), null);
    s.autoDetectMmproj();
    expect(useAppStore.getState().flags.mmproj).toBe(""); // NOT re-added
  });

  it("autoDetectMmproj clears a stale carried-over projector when the folder has none", () => {
    const s = useAppStore.getState();
    s.setFlag("model", "/m/v.gguf");
    s.setFlag("mmproj", "/old/proj.gguf"); // carried over, not pinned
    s.setModelInfo(ggufInfo([]), null);
    s.autoDetectMmproj();
    expect(useAppStore.getState().flags.mmproj).toBe("");
  });

  it("unpinMmproj returns the model to auto-detection and re-derives immediately", () => {
    const s = useAppStore.getState();
    s.setFlag("model", "/m/v.gguf");
    s.setMmproj(""); // pinned text-only
    s.setModelInfo(ggufInfo(["/m/mmproj-v.gguf"]), null);
    s.unpinMmproj();
    const st = useAppStore.getState();
    expect(st.settings.mmproj_pinned).not.toContain("/m/v.gguf");
    expect(st.flags.mmproj).toBe("/m/mmproj-v.gguf"); // re-detected on unpin
  });

  it("forgetModelConfig also unpins mmproj for the model", async () => {
    const s = useAppStore.getState();
    s.setFlag("model", "/m/v.gguf");
    s.setMmproj("/m/mmproj-v.gguf");
    s.forgetModelConfig();
    await flush();
    expect(useAppStore.getState().settings.mmproj_pinned).not.toContain("/m/v.gguf");
  });
});
