import { describe, it, expect } from "vitest";
import { quantDescription } from "./quant";

describe("quantDescription", () => {
  it("describes common 4-bit k-quants as small & fast", () => {
    const d = quantDescription("Q4_K_M");
    expect(d).toContain("Q4_K_M");
    expect(d).toMatch(/4-bit/);
    expect(d).toMatch(/small & fast/i);
  });

  it("describes Q8_0 as near-lossless", () => {
    const d = quantDescription("Q8_0");
    expect(d).toMatch(/8-bit/);
    expect(d).toMatch(/near-lossless/i);
  });

  it("describes lower bit depths (Q2/Q3) with their tradeoffs", () => {
    expect(quantDescription("Q2_K")).toMatch(/2-bit/);
    expect(quantDescription("Q2_K")).toMatch(/quality loss/i);
    expect(quantDescription("Q3_K_S")).toMatch(/3-bit/);
  });

  it("handles float formats", () => {
    expect(quantDescription("F16")).toMatch(/16-bit float/i);
    expect(quantDescription("BF16")).toMatch(/brain float/i);
    expect(quantDescription("F32")).toMatch(/full precision/i);
  });

  it("marks importance-matrix IQ quants", () => {
    const d = quantDescription("IQ2_XS");
    expect(d).toMatch(/2-bit/);
    expect(d).toMatch(/IQ/);
  });

  it("falls back to an N-bit quantization label for unmapped bit widths", () => {
    expect(quantDescription("Q7_0")).toMatch(/7-bit quantization/);
  });

  it("returns a generic label for empty or unknown tags", () => {
    expect(quantDescription("")).toBe("Quantization level");
    expect(quantDescription("MXFP4")).toContain("MXFP4");
  });
});
