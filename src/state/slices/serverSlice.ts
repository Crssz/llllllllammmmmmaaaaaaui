import type { StateCreator } from "zustand";
import { api, type RunningInfo, type ServerStatus } from "../../lib/api";
import { buildArgs } from "../../lib/buildArgs";
import { log } from "../../lib/logger";
import type { AppStore } from "../store";

export type ServerState = { running: boolean; ready: boolean; info: RunningInfo | null };

export type ServerSlice = {
  server: ServerState;
  startError: string | null;
  /** The exact argv the running server was launched with, or null when we
   *  didn't launch it (e.g. it was adopted from a previous app run). Lets a
   *  chat detect a config change and reload the model with the latest flags. */
  loadedArgs: string[] | null;
  setServer: (s: ServerState) => void;
  startServer: (args: string[]) => Promise<void>;
  stopServer: () => Promise<void>;
  reloadServer: () => Promise<void>;
  reloadIfStale: () => Promise<boolean>;
};

const STOPPED: ServerState = { running: false, ready: false, info: null };

function argsEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// Poll the backend until a freshly-(re)started server reports the model loaded,
// or we give up. The background status poll updates the store too, but polling
// here makes a reload-then-send resolve deterministically (and works in tests,
// where the poller isn't mounted). Returns false if the server stops or never
// becomes ready within the timeout.
async function waitForServerReady(get: () => AppStore, timeoutMs: number): Promise<boolean> {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    let st: ServerStatus | null;
    try {
      st = await api.serverStatus();
    } catch {
      st = null;
    }
    if (st) {
      get().setServer(st);
      if (!st.running) return false;
      if (st.ready) return true;
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  return get().server.ready;
}

export const createServerSlice: StateCreator<AppStore, [], [], ServerSlice> = (set, get) => ({
  server: STOPPED,
  startError: null,
  loadedArgs: null,

  setServer: (s) => set({ server: s }),

  startServer: async (args) => {
    const buildDir = get().settings.build_dir;
    if (!buildDir) {
      // Surface via a toast too — Load buttons on Models/Catalog/the overlay
      // don't render startError (only Configure's banner does), so without this
      // a first-run user with no build dir clicks Load and sees nothing.
      const msg = "Pick a llama.cpp build directory first.";
      log.notify("warn", "server", msg);
      set({ startError: msg });
      return;
    }
    set({ startError: null });
    log.info("server", `starting llama-server`, { build_dir: buildDir, arg_count: args.length });
    log.debug("server", `argv: ${args.join(" ")}`);
    try {
      const info = await api.startServer(buildDir, args);
      // Record the launch argv so a later config change can be detected and the
      // model reloaded with the latest flags instead of these.
      set({ server: { running: true, ready: false, info }, loadedArgs: args });
      log.info("server", `started: pid=${info.pid} port=${info.port} (loading model…)`, {
        binary: info.binary,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // notify() logs at error level AND raises a user-visible toast, so a Load
      // from a surface that doesn't show startError still reports the failure.
      log.notify("error", "server", `Failed to start llama-server: ${msg}`);
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
      set({ server: STOPPED, loadedArgs: null });
    }
  },

  // Restart the server with the current flags so a freshly switched model
  // takes effect. Stops a running server first, then starts; if it was
  // already stopped this just starts it. Builds the same argv the Configure
  // tab does, so callers (the model picker, Models tab) don't have to.
  reloadServer: async () => {
    const { flags } = get();
    const args = buildArgs(flags);
    if (get().server.running) {
      await get().stopServer();
    }
    await get().startServer(args);
  },

  // Reconcile the running server with the current Configure flags before a
  // chat: if the model was loaded with a different config, restart llama-server
  // with the latest flags and wait for it to come back, so the turn never runs
  // on the previously-loaded config. Returns true when the server is already
  // current or the reload succeeded; false only when a reload was needed but
  // the server didn't come back ready. A no-op (returns true) when the server
  // isn't running, or when we didn't launch it (loaded config unknown — we
  // can't prove it's stale, so we don't force a costly model reload).
  reloadIfStale: async () => {
    const { server, flags, loadedArgs } = get();
    if (!server.running || !loadedArgs) return true;
    const args = buildArgs(flags);
    if (argsEqual(args, loadedArgs)) return true;
    log.info("server", "config changed since model load — reloading with latest flags before chat");
    await get().reloadServer();
    return waitForServerReady(get, 180_000);
  },
});
