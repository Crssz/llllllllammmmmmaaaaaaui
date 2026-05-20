import { describe, it, expect } from "vitest";
import { splitThink } from "../state";

describe("splitThink", () => {
  it("returns full content when no think block is present", () => {
    const r = splitThink("Hello world");
    expect(r.content).toBe("Hello world");
    expect(r.reasoning).toBe("");
  });

  it("extracts a single think block", () => {
    const r = splitThink("before<think>secret</think>after");
    expect(r.content).toBe("beforeafter");
    expect(r.reasoning).toBe("secret");
  });

  it("handles an unterminated think tag as reasoning to EOF", () => {
    const r = splitThink("ok<think>in progress");
    expect(r.content).toBe("ok");
    expect(r.reasoning).toBe("in progress");
  });

  it("concatenates multiple think blocks", () => {
    const r = splitThink("a<think>x</think>b<think>y</think>c");
    expect(r.content).toBe("abc");
    expect(r.reasoning).toBe("xy");
  });

  it("trims surrounding whitespace", () => {
    const r = splitThink("  hi  <think>  hmm  </think>  ");
    expect(r.content).toBe("hi");
    expect(r.reasoning).toBe("hmm");
  });

  it("returns empty strings for an empty input", () => {
    expect(splitThink("")).toEqual({ content: "", reasoning: "" });
  });
});
