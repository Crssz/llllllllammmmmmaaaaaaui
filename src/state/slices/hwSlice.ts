import type { StateCreator } from "zustand";
import type { HwSnapshot } from "../../lib/api";
import { pushSeries } from "../../lib/series";
import type { AppStore } from "../store";

export type HwSeries = { cpu: number[]; ram: number[]; vram: number[]; gpu: number[] };

export type HwSlice = {
  hw: HwSnapshot | null;
  hwSeries: HwSeries;
  applyHwSnapshot: (snap: HwSnapshot) => void;
};

export const createHwSlice: StateCreator<AppStore, [], [], HwSlice> = (set, get) => ({
  hw: null,
  hwSeries: { cpu: [], ram: [], vram: [], gpu: [] },

  applyHwSnapshot: (snap) => {
    const gpu0 = snap.gpus[0];
    const s = get().hwSeries;
    set({
      hw: snap,
      hwSeries: {
        cpu: pushSeries(s.cpu, snap.cpu_util),
        ram: pushSeries(
          s.ram,
          snap.ram_total_gb > 0 ? (snap.ram_used_gb / snap.ram_total_gb) * 100 : 0,
        ),
        vram: pushSeries(
          s.vram,
          gpu0 && gpu0.vram_total_gb > 0 ? (gpu0.vram_used_gb / gpu0.vram_total_gb) * 100 : 0,
        ),
        gpu: pushSeries(s.gpu, gpu0?.util ?? 0),
      },
    });
  },
});
