import { describe, it, expect } from "vitest";
import { buildMtmdArgs, type MtmdOpts } from "./buildMtmdArgs";

function base(overrides: Partial<MtmdOpts> = {}): MtmdOpts {
  return {
    model: "/m/model.gguf",
    mmproj: "/m/mmproj.gguf",
    audio: "/a/clip.wav",
    prompt: "Transcribe the audio.",
    ...overrides,
  };
}

function valAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

describe("buildMtmdArgs", () => {
  it("always emits the required model/mmproj/audio/prompt quartet", () => {
    const args = buildMtmdArgs(base());
    expect(valAfter(args, "--model")).toBe("/m/model.gguf");
    expect(valAfter(args, "--mmproj")).toBe("/m/mmproj.gguf");
    expect(valAfter(args, "--audio")).toBe("/a/clip.wav");
    expect(valAfter(args, "--prompt")).toBe("Transcribe the audio.");
  });

  it("keeps a multi-word prompt as a single argv token", () => {
    const args = buildMtmdArgs(base({ prompt: "what is said here?" }));
    const i = args.indexOf("--prompt");
    expect(args[i + 1]).toBe("what is said here?");
    // The next element after the prompt value must not be a stray prompt word.
    expect(args[i + 2]).toBeUndefined();
  });

  it("omits --n-gpu-layers only when ngl is null/undefined", () => {
    expect(buildMtmdArgs(base())).not.toContain("--n-gpu-layers");
    expect(buildMtmdArgs(base({ ngl: null }))).not.toContain("--n-gpu-layers");
    // 0 is meaningful (CPU only) and must be emitted.
    expect(valAfter(buildMtmdArgs(base({ ngl: 0 })), "--n-gpu-layers")).toBe("0");
    expect(valAfter(buildMtmdArgs(base({ ngl: 99 })), "--n-gpu-layers")).toBe("99");
  });

  it("emits optional tuning flags only when set to sane values", () => {
    const args = buildMtmdArgs(base({ threads: 8, ctx: 4096, temp: 0, nPredict: 256 }));
    expect(valAfter(args, "--threads")).toBe("8");
    expect(valAfter(args, "--ctx-size")).toBe("4096");
    expect(valAfter(args, "--temp")).toBe("0");
    expect(valAfter(args, "--n-predict")).toBe("256");
  });

  it("drops non-positive threads/ctx/nPredict", () => {
    const args = buildMtmdArgs(base({ threads: 0, ctx: 0, nPredict: 0 }));
    expect(args).not.toContain("--threads");
    expect(args).not.toContain("--ctx-size");
    expect(args).not.toContain("--n-predict");
  });
});
