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

  it("omits --kv-mode, --idle-timeout, --spec, -md, --draft-max, --tp when unset", () => {
    const args = buildHipfireArgs({ tag: "t" });
    expect(args).not.toContain("--kv-mode");
    expect(args).not.toContain("--idle-timeout");
    expect(args).not.toContain("--spec");
    expect(args).not.toContain("-md");
    expect(args).not.toContain("--draft-max");
    expect(args).not.toContain("--tp");
  });

  it("emits --kv-mode and --idle-timeout when set", () => {
    const args = buildHipfireArgs({ tag: "t", kv_mode: "q8", idle_timeout: 300 });
    expect(args[args.indexOf("--kv-mode") + 1]).toBe("q8");
    expect(args[args.indexOf("--idle-timeout") + 1]).toBe("300");
  });

  it("emits bare --spec (a toggle, not a valued flag) when spec is truthy", () => {
    const args = buildHipfireArgs({ tag: "t", spec: true });
    const i = args.indexOf("--spec");
    expect(i).toBeGreaterThanOrEqual(0);
    // The next token is not a value for --spec — it's absent entirely here.
    expect(args[i + 1]).toBeUndefined();
  });

  it("emits -md and --draft-max when a draft model + max are set", () => {
    const args = buildHipfireArgs({ tag: "t", model_draft: "qwen3.6:27b-draft", draft_max: 16 });
    expect(args[args.indexOf("-md") + 1]).toBe("qwen3.6:27b-draft");
    expect(args[args.indexOf("--draft-max") + 1]).toBe("16");
  });

  it("emits --tp when set", () => {
    const args = buildHipfireArgs({ tag: "t", tp: 2 });
    expect(args[args.indexOf("--tp") + 1]).toBe("2");
  });

  it("does not require a model path — hipfire serves a pre-registered tag, not a raw gguf", () => {
    const args = buildHipfireArgs({ tag: "t" });
    expect(args).not.toContain("-m");
    expect(args).not.toContain("--model");
  });
});
