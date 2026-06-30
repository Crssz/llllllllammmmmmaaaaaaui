import { describe, it, expect } from "vitest";
import { resolveMmproj } from "./mmproj";

describe("resolveMmproj", () => {
  const SIB = "/m/mmproj-model-f16.gguf";

  it("fills an empty value from the sibling (first-load vision model)", () => {
    expect(resolveMmproj("", [SIB])).toEqual({ type: "set", value: SIB });
  });

  it("leaves a value that is already a valid sibling", () => {
    expect(resolveMmproj(SIB, [SIB])).toEqual({ type: "none" });
  });

  it("re-points a stale/relocated path to the real sibling", () => {
    expect(resolveMmproj("/old/dir/mmproj-model-f16.gguf", [SIB])).toEqual({
      type: "set",
      value: SIB,
    });
  });

  it("clears a value when the model folder has no projector", () => {
    expect(resolveMmproj("/some/proj.gguf", [])).toEqual({ type: "clear" });
  });

  it("does nothing for a text model with no value and no sibling", () => {
    expect(resolveMmproj("", [])).toEqual({ type: "none" });
  });

  it("adopts the first sibling when several exist", () => {
    const a = "/m/mmproj-a.gguf";
    const b = "/m/mmproj-b.gguf";
    expect(resolveMmproj("", [a, b])).toEqual({ type: "set", value: a });
  });
});
