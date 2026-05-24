import { describe, it, expect } from "vitest";
import { pushSeries, SERIES_LEN } from "./series";

describe("pushSeries", () => {
  it("appends values to a short buffer", () => {
    expect(pushSeries([], 1)).toEqual([1]);
    expect(pushSeries([1, 2], 3)).toEqual([1, 2, 3]);
  });

  it("returns a fresh array (does not mutate input)", () => {
    const buf = [1, 2];
    const out = pushSeries(buf, 3);
    expect(buf).toEqual([1, 2]);
    expect(out).not.toBe(buf);
  });

  it("slides a fixed-length window", () => {
    const buf = Array.from({ length: SERIES_LEN }, (_, i) => i);
    const out = pushSeries(buf, 999);
    expect(out).toHaveLength(SERIES_LEN);
    expect(out[SERIES_LEN - 1]).toBe(999);
    expect(out[0]).toBe(1);
  });

  it("honours an overridden max", () => {
    const out = pushSeries([1, 2, 3, 4], 5, 3);
    expect(out).toEqual([3, 4, 5]);
  });
});
