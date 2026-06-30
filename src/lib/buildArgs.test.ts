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
    model_draft_dflash: "",
    spec_dflash_n_max: 16,
    spec_dflash_n_min: 0,
    ngld_dflash: 99,
    ctx_draft_dflash: 256,
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
    const args = buildArgs(baseVals());
    expect(args).toContain("--host");
    expect(args).toContain("--port");
    expect(args[args.indexOf("--port") + 1]).toBe("8080");
  });

  it("includes --model when set", () => {
    const args = buildArgs(baseVals({ model: "/path/to/model.gguf" }));
    const idx = args.indexOf("--model");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("/path/to/model.gguf");
  });

  it("omits --model when empty", () => {
    const args = buildArgs(baseVals({ model: "" }));
    expect(args).not.toContain("--model");
  });

  it("respects the ngl value", () => {
    const args = buildArgs(baseVals({ ngl: 42 }));
    const i = args.indexOf("--n-gpu-layers");
    expect(args[i + 1]).toBe("42");
  });

  it("emits --jinja as a bare flag (no value)", () => {
    const args = buildArgs(baseVals({ jinja: true }));
    const i = args.indexOf("--jinja");
    expect(i).toBeGreaterThanOrEqual(0);
    // Next token should be another flag, not "true"
    expect(args[i + 1]).not.toBe("true");
  });

  it("--flash-attn always carries on/off (never bare)", () => {
    const off = buildArgs(baseVals({ fa: false }));
    const on = buildArgs(baseVals({ fa: true }));
    expect(off[off.indexOf("--flash-attn") + 1]).toBe("off");
    expect(on[on.indexOf("--flash-attn") + 1]).toBe("on");
  });

  it("emits --no-mmap only when mmap is false", () => {
    expect(buildArgs(baseVals({ mmap: true }))).not.toContain("--no-mmap");
    expect(buildArgs(baseVals({ mmap: false }))).toContain("--no-mmap");
  });

  it("draft-mtp without a drafter omits --model-draft", () => {
    const args = buildArgs(baseVals({ spec_type: "draft-mtp" }));
    expect(args).toContain("--spec-type");
    expect(args[args.indexOf("--spec-type") + 1]).toBe("draft-mtp");
    expect(args).not.toContain("--model-draft");
  });

  it("draft-mtp with an explicit drafter emits --model-draft", () => {
    const args = buildArgs(
      baseVals({ spec_type: "draft-mtp", model_draft_mtp: "/mtp/heads.gguf", spec_n_max: 4 }),
    );
    expect(args[args.indexOf("--spec-type") + 1]).toBe("draft-mtp");
    expect(args[args.indexOf("--model-draft") + 1]).toBe("/mtp/heads.gguf");
    expect(args[args.indexOf("--spec-draft-n-max") + 1]).toBe("4");
  });

  it("draft-simple only emits when model_draft is set", () => {
    const without = buildArgs(baseVals({ spec_type: "draft-simple", model_draft: "" }));
    expect(without).not.toContain("--spec-type");

    const withDraft = buildArgs(
      baseVals({ spec_type: "draft-simple", model_draft: "/draft.gguf" }),
    );
    expect(withDraft).toContain("--spec-type");
    expect(withDraft).toContain("--model-draft");
  });

  it("draft-dflash without a drafter omits --spec-type", () => {
    const args = buildArgs(baseVals({ spec_type: "draft-dflash", model_draft_dflash: "" }));
    expect(args).not.toContain("--spec-type");
    expect(args).not.toContain("--model-draft");
  });

  it("draft-dflash with a drafter emits spec-type, model-draft and block flags", () => {
    const args = buildArgs(
      baseVals({
        spec_type: "draft-dflash",
        model_draft_dflash: "/dflash/drafter.gguf",
        spec_dflash_n_max: 15,
        ngld_dflash: 99,
        ctx_draft_dflash: 256,
      }),
    );
    expect(args[args.indexOf("--spec-type") + 1]).toBe("draft-dflash");
    expect(args[args.indexOf("--model-draft") + 1]).toBe("/dflash/drafter.gguf");
    expect(args[args.indexOf("--spec-draft-n-max") + 1]).toBe("15");
    expect(args[args.indexOf("--n-gpu-layers-draft") + 1]).toBe("99");
    expect(args[args.indexOf("--ctx-size-draft") + 1]).toBe("256");
    // n-min defaults to 0, which is omitted
    expect(args).not.toContain("--spec-draft-n-min");
  });

  it("draft-dflash emits --spec-draft-n-min only when > 0", () => {
    const args = buildArgs(
      baseVals({
        spec_type: "draft-dflash",
        model_draft_dflash: "/d.gguf",
        spec_dflash_n_min: 2,
      }),
    );
    expect(args[args.indexOf("--spec-draft-n-min") + 1]).toBe("2");
  });

  it("rope defaults are omitted (none/auto)", () => {
    const args = buildArgs(baseVals());
    expect(args).not.toContain("--rope-scaling");
    expect(args).not.toContain("--rope-freq-base");
    expect(args).not.toContain("--rope-freq-scale");
  });

  it("api-key only emits when provided", () => {
    expect(buildArgs(baseVals())).not.toContain("--api-key");
    const withKey = buildArgs(baseVals({ api_key: "sk-test" }));
    expect(withKey).toContain("--api-key");
  });
});
