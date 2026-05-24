import { describe, it, expect, beforeEach } from "vitest";
import { freshStore, stubApi, useAppStore } from "../testUtils";
import type { HwSnapshot } from "../../lib/api";

function snap(over: Partial<HwSnapshot> = {}): HwSnapshot {
  return {
    cpu_util: 10,
    cpu_name: "cpu",
    cpu_cores: 4,
    cpu_freq_ghz: 3.0,
    ram_total_gb: 16,
    ram_used_gb: 8,
    swap_used_gb: 0,
    gpus: [
      {
        name: "gpu0",
        vram_total_gb: 24,
        vram_used_gb: 6,
        util: 50,
        temp_c: null,
        power_w: null,
        clock_mhz: null,
      },
    ],
    gpu_backend: "cuda",
    ...over,
  };
}

describe("hw slice", () => {
  beforeEach(() => {
    freshStore();
    stubApi();
  });

  it("applyHwSnapshot appends ratios to the series", () => {
    useAppStore.getState().applyHwSnapshot(snap());
    const s = useAppStore.getState();
    expect(s.hw?.cpu_util).toBe(10);
    expect(s.hwSeries.cpu).toEqual([10]);
    expect(s.hwSeries.ram).toEqual([50]);
    expect(s.hwSeries.vram).toEqual([25]);
    expect(s.hwSeries.gpu).toEqual([50]);
  });

  it("handles a missing GPU (no VRAM, util→0)", () => {
    useAppStore.getState().applyHwSnapshot(snap({ gpus: [] }));
    expect(useAppStore.getState().hwSeries.vram).toEqual([0]);
    expect(useAppStore.getState().hwSeries.gpu).toEqual([0]);
  });

  it("handles zero ram_total_gb without dividing", () => {
    useAppStore.getState().applyHwSnapshot(snap({ ram_total_gb: 0, ram_used_gb: 0 }));
    expect(useAppStore.getState().hwSeries.ram).toEqual([0]);
  });
});
