import { describe, it, expect } from "vitest";
import { defaultProfileName } from "./Profiles";
import { makeSettings } from "../state/testUtils";

describe("defaultProfileName", () => {
  it("derives from the model filename under llama", () => {
    const name = defaultProfileName(
      { model: "C:/models/owner/model/model.Q4_K.gguf" },
      makeSettings({ engine_kind: "llama" }),
    );
    expect(name).toBe("model.Q4_K");
  });

  it("falls back to 'untitled' under llama with no model set", () => {
    const name = defaultProfileName({}, makeSettings({ engine_kind: "llama" }));
    expect(name).toBe("untitled");
  });

  it("derives from the hipfire tag under hipfire, ignoring flags.model", () => {
    const name = defaultProfileName(
      { model: "" },
      makeSettings({ engine_kind: "hipfire", hipfire_flags: { tag: "qwen3.6:27b" } }),
    );
    expect(name).toBe("qwen3.6:27b");
  });

  it("falls back to 'untitled' under hipfire with no tag set", () => {
    const name = defaultProfileName({}, makeSettings({ engine_kind: "hipfire", hipfire_flags: {} }));
    expect(name).toBe("untitled");
  });
});
