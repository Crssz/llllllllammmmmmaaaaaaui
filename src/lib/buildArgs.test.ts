import { describe, it, expect } from "vitest";
import { buildArgs, type Values } from "./buildArgs";

// Minimum-viable default values for the flag set buildArgs consumes. Mirrors
// what FLAG_GROUPS would normally provide at runtime.
function baseVals(overrides: Partial<Values> = {}): Values {
  return {
    model: "",
    alias: "",
    lora: "",
    mmproj: "",
    ctx: 8192,
    batch: 2048,
    ubatch: 512,
    parallel: 1,
    ngl: 0,
    threads: 8,
    tb: 8,
    split: "layer",
    main_gpu: "0",
    fa: false,
    mmap: true,
    mlock: false,
    ctk: "f16",
    ctv: "f16",
    nkvo: false,
    spec_type: "none",
    spec_n_max: 8,
    spec_n_min: 0,
    model_draft_mtp: "",
    model_draft: "",
    ngld: 0,
    ctx_draft: 4096,
    draft_max: 16,
    draft_min: 5,
    draft_p_min: 0.5,
    device_draft: "auto",
    jinja: false,
    chat_template: "",
    chat_template_file: "",
    reasoning_format: "auto",
    rope_scaling: "none",
    rope_base: "auto",
    rope_scale: "auto",
    host: "127.0.0.1",
    port: "8080",
    api_key: "",
    slots: "",
    ...overrides,
  };
}

describe("buildArgs", () => {
  it("emits host/port even with defaults", () => {
    const args = buildArgs(baseVals(), "manual");
    expect(args).toContain("--host");
    expect(args).toContain("--port");
    expect(args[args.indexOf("--port") + 1]).toBe("8080");
  });

  it("includes --model when set", () => {
    const args = buildArgs(baseVals({ model: "/path/to/model.gguf" }), "manual");
    const idx = args.indexOf("--model");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("/path/to/model.gguf");
  });

  it("omits --model when empty", () => {
    const args = buildArgs(baseVals({ model: "" }), "manual");
    expect(args).not.toContain("--model");
  });

  it("Auto agency overrides ngl to 100", () => {
    const args = buildArgs(baseVals({ ngl: 5 }), "auto");
    const i = args.indexOf("--n-gpu-layers");
    expect(args[i + 1]).toBe("100");
  });

  it("Manual respects ngl value", () => {
    const args = buildArgs(baseVals({ ngl: 42 }), "manual");
    const i = args.indexOf("--n-gpu-layers");
    expect(args[i + 1]).toBe("42");
  });

  it("emits --jinja as a bare flag (no value)", () => {
    const args = buildArgs(baseVals({ jinja: true }), "manual");
    const i = args.indexOf("--jinja");
    expect(i).toBeGreaterThanOrEqual(0);
    // Next token should be another flag, not "true"
    expect(args[i + 1]).not.toBe("true");
  });

  it("--flash-attn always carries on/off (never bare)", () => {
    const off = buildArgs(baseVals({ fa: false }), "manual");
    const on = buildArgs(baseVals({ fa: true }), "manual");
    expect(off[off.indexOf("--flash-attn") + 1]).toBe("off");
    expect(on[on.indexOf("--flash-attn") + 1]).toBe("on");
  });

  it("emits --no-mmap only when mmap is false", () => {
    expect(buildArgs(baseVals({ mmap: true }), "manual")).not.toContain("--no-mmap");
    expect(buildArgs(baseVals({ mmap: false }), "manual")).toContain("--no-mmap");
  });

  it("draft-mtp without a drafter omits --model-draft", () => {
    const args = buildArgs(baseVals({ spec_type: "draft-mtp" }), "manual");
    expect(args).toContain("--spec-type");
    expect(args[args.indexOf("--spec-type") + 1]).toBe("draft-mtp");
    expect(args).not.toContain("--model-draft");
  });

  it("draft-mtp with an explicit drafter emits --model-draft", () => {
    const args = buildArgs(
      baseVals({ spec_type: "draft-mtp", model_draft_mtp: "/mtp/heads.gguf", spec_n_max: 4 }),
      "manual",
    );
    expect(args[args.indexOf("--spec-type") + 1]).toBe("draft-mtp");
    expect(args[args.indexOf("--model-draft") + 1]).toBe("/mtp/heads.gguf");
    expect(args[args.indexOf("--spec-draft-n-max") + 1]).toBe("4");
  });

  it("draft-simple only emits when model_draft is set", () => {
    const without = buildArgs(baseVals({ spec_type: "draft-simple", model_draft: "" }), "manual");
    expect(without).not.toContain("--spec-type");

    const withDraft = buildArgs(
      baseVals({ spec_type: "draft-simple", model_draft: "/draft.gguf" }),
      "manual",
    );
    expect(withDraft).toContain("--spec-type");
    expect(withDraft).toContain("--model-draft");
  });

  it("rope defaults are omitted (none/auto)", () => {
    const args = buildArgs(baseVals(), "manual");
    expect(args).not.toContain("--rope-scaling");
    expect(args).not.toContain("--rope-freq-base");
    expect(args).not.toContain("--rope-freq-scale");
  });

  it("api-key only emits when provided", () => {
    expect(buildArgs(baseVals(), "manual")).not.toContain("--api-key");
    const withKey = buildArgs(baseVals({ api_key: "sk-test" }), "manual");
    expect(withKey).toContain("--api-key");
  });
});
