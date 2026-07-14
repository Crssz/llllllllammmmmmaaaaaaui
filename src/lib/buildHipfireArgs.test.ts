import { describe, it, expect } from "vitest";
import { buildHipfireArgs } from "./buildHipfireArgs";

describe("buildHipfireArgs", () => {
  it("always emits serve <tag> <host:port> positionally, even with an empty flag bag", () => {
    const args = buildHipfireArgs({});
    expect(args[0]).toBe("serve");
    expect(args[1]).toBe(""); // no tag set yet
    expect(args[2]).toBe("127.0.0.1:8080");
  });

  it("carries the tag through as the first positional argument", () => {
    const args = buildHipfireArgs({ tag: "qwen3.6:27b" });
    expect(args).toEqual(["serve", "qwen3.6:27b", "127.0.0.1:8080"]);
  });

  it("defaults host to 127.0.0.1 and port to 8080", () => {
    const args = buildHipfireArgs({ tag: "t" });
    expect(args[2]).toBe("127.0.0.1:8080");
  });

  it("respects an explicit host and port", () => {
    const args = buildHipfireArgs({ tag: "t", host: "0.0.0.0", port: 9090 });
    expect(args[2]).toBe("0.0.0.0:9090");
  });

  it("falls back to defaults when host/port are empty strings", () => {
    const args = buildHipfireArgs({ tag: "t", host: "", port: "" });
    expect(args[2]).toBe("127.0.0.1:8080");
  });

  it("omits --kv-mode, --idle-timeout, --tp when unset", () => {
    const args = buildHipfireArgs({ tag: "t" });
    expect(args).not.toContain("--kv-mode");
    expect(args).not.toContain("--idle-timeout");
    expect(args).not.toContain("--tp");
  });

  it("emits --kv-mode and --idle-timeout when set", () => {
    const args = buildHipfireArgs({ tag: "t", kv_mode: "q8", idle_timeout: 300 });
    expect(args[args.indexOf("--kv-mode") + 1]).toBe("q8");
    expect(args[args.indexOf("--idle-timeout") + 1]).toBe("300");
  });

  it("emits --tp when set", () => {
    const args = buildHipfireArgs({ tag: "t", tp: 2 });
    expect(args[args.indexOf("--tp") + 1]).toBe("2");
  });

  // Regression: --spec/-md/--draft-max are `hipfire run`-only flags — LIVE
  // verification confirmed `hipfire serve --help` doesn't accept them and the
  // daemon fails to start if they're passed. buildHipfireArgs must never emit
  // them on the serve argv, even when those legacy-shaped values are present
  // in the flag bag (e.g. stale settings persisted before this fix).
  it("never emits --spec, -md, or --draft-max on the serve argv, even when those values are set", () => {
    const args = buildHipfireArgs({
      tag: "t",
      spec: true,
      model_draft: "qwen3.6:27b-draft",
      draft_max: 16,
    });
    expect(args).not.toContain("--spec");
    expect(args).not.toContain("-md");
    expect(args).not.toContain("--draft-max");
    expect(args).not.toContain("--model-draft");
    expect(args).not.toContain("--draft");
  });

  it("does not require a model path — hipfire serves a pre-registered tag, not a raw gguf", () => {
    const args = buildHipfireArgs({ tag: "t" });
    expect(args).not.toContain("-m");
    expect(args).not.toContain("--model");
  });
});
