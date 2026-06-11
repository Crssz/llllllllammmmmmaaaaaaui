import type { StateCreator } from "zustand";
import { api, type RunningInfo } from "../../lib/api";
import { buildArgs } from "../../lib/buildArgs";
import { log } from "../../lib/logger";
import type { AppStore } from "../store";

export type ServerState = { running: boolean; ready: boolean; info: RunningInfo | null };

export type ServerSlice = {
  server: ServerState;
  startError: string | null;
  setServer: (s: ServerState) => void;
  startServer: (args: string[]) => Promise<void>;
  stopServer: () => Promise<void>;
  reloadServer: () => Promise<void>;
};

const STOPPED: ServerState = { running: false, ready: false, info: null };

export const createServerSlice: StateCreator<AppStore, [], [], ServerSlice> = (set, get) => ({
  server: STOPPED,
  startError: null,

  setServer: (s) => set({ server: s }),

  startServer: async (args) => {
    const buildDir = get().settings.build_dir;
    if (!buildDir) {
      log.warn("server", "start blocked: no build_dir set");
      set({ startError: "Pick a llama.cpp build directory first." });
      return;
    }
    set({ startError: null });
    log.info("server", `starting llama-server`, { build_dir: buildDir, arg_count: args.length });
    log.debug("server", `argv: ${args.join(" ")}`);
    try {
      const info = await api.startServer(buildDir, args);
      set({ server: { running: true, ready: false, info } });
      log.info("server", `started: pid=${info.pid} port=${info.port} (loading model…)`, {
        binary: info.binary,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error("server", `start failed`, { error: msg });
      set({ startError: msg });
    }
  },

  stopServer: async () => {
    log.info("server", "stop requested");
    try {
      await api.stopServer();
      log.info("server", "stopped");
    } catch (e: unknown) {
      log.error("server", "stop failed", { error: String(e) });
    } finally {
      set({ server: STOPPED });
    }
  },

  // Restart the server with the current flags + agency so a freshly switched
  // model takes effect. Stops a running server first, then starts; if it was
  // already stopped this just starts it. Builds the same argv the Configure
  // tab does, so callers (the model picker, Models tab) don't have to.
  reloadServer: async () => {
    const { flags, agency } = get();
    const args = buildArgs(flags, agency);
    if (get().server.running) {
      await get().stopServer();
    }
    await get().startServer(args);
  },
});
