import type { StateCreator } from "zustand";
import { api, type RunningInfo, type ServerStatus } from "../../lib/api";
import { buildArgs } from "../../lib/buildArgs";
import { buildHipfireArgs } from "../../lib/buildHipfireArgs";
import { log } from "../../lib/logger";
import type { EngineKind, FlagValues } from "../types";
import type { AppStore } from "../store";

export type ServerState = { running: boolean; ready: boolean; info: RunningInfo | null };

export type ServerSlice = {
  server: ServerState;
  startError: string | null;
  /** The exact argv the running server was launched with, or null when we
   *  didn't launch it (e.g. it was adopted from a previous app run). Lets a
   *  chat detect a config change and reload the model with the latest flags. */
  loadedArgs: string[] | null;
  /** Which engine the running server was actually launched as, or null when no
   *  server is running (or one was adopted and we didn't launch it). Feature
   *  gates key off what's RUNNING rather than what the Configure toggle now
   *  says — e.g. transcription stays available on a live llama-server even
   *  after the user flips the engine toggle without restarting. */
  loadedEngine: EngineKind | null;
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

// Build the launch argv for whichever engine is active. hipfire consumes its
// own flag bag (settings.hipfire_flags) — it serves a pre-registered tag, not
// the shared model flag; llama-server uses the full flag set. Both the reload
// path and the staleness check compare against this so they diff the right
// builder.
function activeArgs(get: () => AppStore): string[] {
  const { settings } = get();
  if (settings.engine_kind === "hipfire") {
    return buildHipfireArgs(settings.hipfire_flags as FlagValues);
  }
  return buildArgs(get().flags);
}

// The single source of truth for "which engine is a request being shaped
// for right now" — used by chatSlice (runChatRound + the media-warning
// toast) and transcribeSlice so they can't diverge again. Deliberately keys
// off the RUNNING server, not the Configure toggle: engine_kind only decides
// what the NEXT launch uses, so a server that's already up must be shaped
// for what it actually is. When a server is up and ready but we didn't
// launch it (adopted from a previous app run — loadedEngine is null), fall
// back to "llama" rather than trusting the toggle: an unknown adopted server
// is far more likely the default llama.cpp binary, and llama-shaping is the
// compatible baseline (media allowed, tools preserved, no fabricated token
// estimate) — trusting a stale "hipfire" toggle instead would silently
// mis-shape every request to a live llama-server. Only when NO server is
// running/ready does engine_kind (the next-launch target) decide.
export function activeEngine(get: () => AppStore): EngineKind {
  const { server, loadedEngine, settings } = get();
  const serverReady = server.running && server.ready && !!server.info;
  return serverReady ? (loadedEngine ?? "llama") : settings.engine_kind;
}

// Return the startError hint if the active engine can't legally launch right
// now, or null when its prerequisites are met. Mirrors Configure's start-button
// gating: hipfire needs its exe path AND a tag to serve; llama needs only a
// build directory (it has always launched without a model, so requiring one
// here would regress the llama path). Reload paths consult this BEFORE
// stopping a healthy server, so an engine toggle can't strand the user with a
// dead server the new engine was never able to start. Also stops a hipfire
// launch from reaching the backend with an empty tag.
function launchPrereqError(get: () => AppStore): string | null {
  const { settings } = get();
  if (settings.engine_kind === "hipfire") {
    if (!settings.hipfire_path) return "Set the hipfire executable path first.";
    const tag = String((settings.hipfire_flags as FlagValues)?.tag ?? "");
    if (!tag) return "Set a model tag to serve first (convert a GGUF, or type an existing tag).";
    return null;
  }
  if (!settings.build_dir) return "Pick a llama.cpp build directory first.";
  return null;
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
  loadedEngine: null,

  setServer: (s) => set({ server: s }),

  startServer: async (args) => {
    const { settings } = get();
    const isHipfire = settings.engine_kind === "hipfire";
    // Guard on the active engine's launch prerequisites BEFORE touching a
    // running server, so a doomed (re)start can never leave the user with
    // nothing. This also stops a hipfire launch with an empty tag reaching
    // the backend as `serve ""`.
    const prereqError = launchPrereqError(get);
    if (prereqError) {
      // Surface via a toast too — Load buttons on Models/Catalog/the overlay
      // don't render startError (only Configure's banner does), so without
      // this a first-run user with no prereqs set clicks Load and sees nothing.
      log.notify("warn", "server", prereqError);
      set({ startError: prereqError });
      return;
    }
    const buildDir = settings.build_dir ?? "";
    const exePath = isHipfire ? settings.hipfire_path : null;
    set({ startError: null });
    log.info("server", `starting ${isHipfire ? "hipfire" : "llama-server"}`, {
      build_dir: buildDir,
      exe: exePath ?? undefined,
      arg_count: args.length,
    });
    log.debug("server", `argv: ${args.join(" ")}`);
    try {
      const info = await api.startServer(buildDir, args, exePath, null);
      // Record the launch argv AND the engine we launched as, so a later
      // config change can be detected (reload with the latest flags) and
      // feature gates can key off what's actually running rather than the
      // current toggle.
      set({
        server: { running: true, ready: false, info },
        loadedArgs: args,
        loadedEngine: settings.engine_kind,
      });
      log.info("server", `started: pid=${info.pid} port=${info.port} (loading model…)`, {
        binary: info.binary,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // notify() logs at error level AND raises a user-visible toast, so a Load
      // from a surface that doesn't show startError still reports the failure.
      log.notify("error", "server", `Failed to start ${isHipfire ? "hipfire" : "llama-server"}: ${msg}`);
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
      set({ server: STOPPED, loadedArgs: null, loadedEngine: null });
    }
  },

  // Restart the server with the current flags so a freshly switched model
  // takes effect. Stops a running server first, then starts; if it was
  // already stopped this just starts it. Builds the same argv the Configure
  // tab does, so callers (the model picker, Models tab) don't have to.
  reloadServer: async () => {
    // Validate the active engine's prerequisites BEFORE stopping a healthy
    // server: an engine toggle in Configure changes activeArgs without
    // restarting, so a naive reload would tear down the running server and
    // only then discover the new engine can't launch. Refuse up front instead.
    const prereqError = launchPrereqError(get);
    if (prereqError) {
      log.warn("server", `reload blocked: ${prereqError}`);
      set({ startError: prereqError });
      return;
    }
    const args = activeArgs(get);
    if (get().server.running) {
      await get().stopServer();
    }
    await get().startServer(args);
  },

  // Reconcile the running server with the current Configure flags before a
  // chat: if the model was loaded with a different config, restart the server
  // with the latest flags and wait for it to come back, so the turn never runs
  // on the previously-loaded config. Returns true when the server is already
  // current or the reload succeeded; false only when a reload was needed but
  // the server didn't come back ready. A no-op (returns true) when the server
  // isn't running, or when we didn't launch it (loaded config unknown — we
  // can't prove it's stale, so we don't force a costly model reload).
  reloadIfStale: async () => {
    const { server, loadedArgs } = get();
    if (!server.running || !loadedArgs) return true;
    const args = activeArgs(get);
    if (argsEqual(args, loadedArgs)) return true;
    // Stale — but validate the active engine's prerequisites BEFORE tearing
    // down the healthy server. After an engine toggle, activeArgs is the NEW
    // engine's argv while loadedArgs is the OLD engine's, so this ALWAYS looks
    // stale; if the new engine can't launch (no hipfire path / no tag) a naive
    // reload would stop a working server and then fail the restart. Keep the
    // old server up, surface the hint, and let the chat report a clear error.
    const prereqError = launchPrereqError(get);
    if (prereqError) {
      log.warn("server", `stale reload skipped: ${prereqError}`);
      set({ startError: prereqError });
      return false;
    }
    log.info("server", "config changed since model load — reloading with latest flags before chat");
    await get().reloadServer();
    return waitForServerReady(get, 180_000);
  },
});
