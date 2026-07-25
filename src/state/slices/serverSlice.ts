import type { StateCreator } from "zustand";
import { api, type RunningInfo, type ServerStatus } from "../../lib/api";
import { buildArgs } from "../../lib/buildArgs";
import { buildHipfireArgs } from "../../lib/buildHipfireArgs";
import { log } from "../../lib/logger";
import type { EngineKind, FlagValues } from "../types";
import type { AppStore } from "../store";

export type ServerState = { running: boolean; ready: boolean; info: RunningInfo | null };

/** What the backend's `server-exited` event carries (server.rs
 *  `ServerExitedEvent`), plus the `llama.stderr` tail effects.tsx already
 *  collected for that pid. The tail — not the code — is the useful part: see
 *  `describeServerExit`. */
export type ServerExitReport = {
  pid: number;
  /** Process exit code when the OS reported one, else null. */
  code: number | null;
  /** Platform description of how it ended ("exit code: 1"), or why we can't tell. */
  status: string;
  /** Last few stderr lines from that pid, oldest first. May be empty. */
  stderrTail: string[];
};

/** What the backend's `server-probe-timeout` event carries (server.rs
 *  `ServerProbeTimeoutEvent`), plus the same stderr tail. The process is still
 *  ALIVE here — it just never answered `/health`. */
export type ServerProbeTimeoutReport = {
  pid: number;
  port: number;
  timeoutSecs: number;
  stderrTail: string[];
};

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
  /** Handle an engine process that died without anyone asking it to. Driven by
   *  the backend's `server-exited` event (never by the status poll — see the
   *  action body). */
  handleServerExit: (report: ServerExitReport) => void;
  /** Handle an engine process that spawned, stayed alive, and never became
   *  ready. Driven by the backend's `server-probe-timeout` event. */
  handleServerProbeTimeout: (report: ServerProbeTimeoutReport) => void;
};

const STOPPED: ServerState = { running: false, ready: false, info: null };

/** Longest stderr excerpt to inline in a one-line banner before eliding. */
const MAX_CAUSE_LEN = 220;

/** Lines worth leading with. Matches the vocabulary llama.cpp / hipfire use
 *  when a load fails ("error loading model", "failed to allocate", "unable to
 *  load", "out of memory", …). */
const EXIT_CAUSE_RE = /error|failed|fatal|unable|cannot|out of memory|abort|insufficient/i;

// Pick the single most useful line out of a stderr tail for a one-line banner.
// Prefers the EARLIEST error-shaped line: llama.cpp prints the root cause first
// ("error loading model: unable to allocate buffer of size …") and then
// cascades into progressively vaguer follow-ups ("failed to load model",
// "error: unable to load model"), so the newest line is usually the least
// informative one. Falls back to the newest non-empty line when nothing in the
// tail looks like an error at all.
function pickExitCause(tail: string[]): string | null {
  const lines = tail.map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const cause = lines.find((l) => EXIT_CAUSE_RE.test(l)) ?? lines[lines.length - 1];
  return cause.length > MAX_CAUSE_LEN ? `${cause.slice(0, MAX_CAUSE_LEN - 1)}…` : cause;
}

// "llama-server" / "hipfire" — what the user actually launched, preferring the
// engine the dead process was launched AS over the Configure toggle (which may
// already have been flipped to something else).
function engineLabel(get: () => AppStore): string {
  const { loadedEngine, settings } = get();
  return (loadedEngine ?? settings.engine_kind) === "hipfire" ? "hipfire" : "llama-server";
}

// Compose the user-facing message for a process that died on its own.
//
// Leads with the stderr tail because that is the only part naming a real cause:
// llama-server returns 1 for every "failed to load model", and a VRAM/driver
// abort on Windows surfaces as a large NTSTATUS, so the code is a footnote, not
// a headline.
//
// The pid is baked into the string on purpose. Configure's banner hides a
// message it has already had dismissed, comparing by exact string equality and
// never resetting on a new start — so without a per-attempt discriminator, a
// user who dismisses "exited (1): failed to load model" and retries the same
// ctx/ngl would get a byte-identical string and NO banner the second time:
// precisely the silent retry loop this fix exists to end. Two attempts always
// have different pids.
export function describeServerExit(engine: string, e: ServerExitReport): string {
  const cause = pickExitCause(e.stderrTail);
  const head = cause
    ? `${engine} exited unexpectedly: ${cause}`
    : `${engine} exited unexpectedly before it finished loading (it printed nothing to stderr).`;
  const footnote = e.code === null ? e.status : `exit code ${e.code}`;
  return `${head} (pid ${e.pid}, ${footnote}) — see the logs panel for the full output.`;
}

/** Exact positional comparison of two launch argvs — the single definition of
 *  "these two launches would be the same launch". `reloadIfStale` below decides
 *  whether a chat has to restart the server with it, and the Models table and
 *  the library overlay render their "loaded" vs "differs from running server"
 *  badges with it, so a badge can never claim a match the reload wouldn't. It
 *  lives here, next to `loadedArgs`, rather than in lib/buildArgs.ts: this slice
 *  is what records the argv every comparison is made against. */
export function argvEqual(a: string[], b: string[]): boolean {
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

// The active model's identity for whichever engine is actually driving
// requests (per activeEngine above — a RUNNING server wins over the toggle,
// same as request-shaping). llama identifies its model by the full GGUF path
// in `flags.model` — callers basename it for display, mirroring the existing
// Chat/TopBar badges. hipfire has no --model flag and no /props endpoint
// (fact 5): it identifies its model by the configured `hipfire_flags.tag`,
// used as-is (a tag isn't a path). Returns null when nothing is chosen yet —
// Chat's send gate and the model badges treat that as "can't send yet".
export function activeModelLabel(get: () => AppStore): string | null {
  const { flags, settings } = get();
  if (activeEngine(get) === "hipfire") {
    const tag = String((settings.hipfire_flags as FlagValues)?.tag ?? "").trim();
    return tag || null;
  }
  const model = String(flags.model ?? "").trim();
  return model || null;
}

// Return the startError hint if the active engine can't legally launch right
// now, or null when its prerequisites are met. Mirrors Configure's start-button
// gating: hipfire only needs a tag to serve — the binary itself is optional
// and auto-resolves (explicit hipfire_path, else the `hipfire` CLI on PATH,
// else ~/.hipfire/bin); a binary that can't be found surfaces as a launch-time
// error instead of blocking here. llama needs only a build directory (it has
// always launched without a model, so requiring one here would regress the
// llama path). Reload paths consult this BEFORE stopping a healthy server, so
// an engine toggle can't strand the user with a dead server the new engine was
// never able to start. Also stops a hipfire launch from reaching the backend
// with an empty tag.
export function launchPrereqError(get: () => AppStore): string | null {
  const { settings } = get();
  if (settings.engine_kind === "hipfire") {
    const tag = String((settings.hipfire_flags as FlagValues)?.tag ?? "");
    if (!tag) return "Set a model tag to serve first (convert a GGUF, or type an existing tag).";
    return null;
  }
  if (!settings.build_dir) return "Pick a llama.cpp build directory first.";
  return null;
}

// Resolve the binary to spawn for the active engine. llama-server resolves
// its own binary under build_dir on the backend, so this only does work for
// hipfire: `settings.hipfire_path` wins when it names a real file, otherwise
// the backend searches PATH for the installed `hipfire` CLI shim and falls
// back to the canonical `~/.hipfire/bin` install dir. Returns `{ exePath }`
// on success (null for llama) or `{ error }` when hipfire and no binary can
// be found anywhere — the caller is responsible for surfacing that error
// and bailing out BEFORE touching a running server (see the prereq-before-
// teardown pattern in reloadServer/reloadIfStale).
async function resolveExePath(
  get: () => AppStore,
): Promise<{ exePath: string | null } | { error: string }> {
  const { settings } = get();
  if (settings.engine_kind !== "hipfire") return { exePath: null };
  try {
    const exePath = await api.resolveHipfireBin(settings.hipfire_path ?? "");
    return { exePath };
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
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
    // Resolve the binary to spawn (hipfire only — llama resolves its own
    // under build_dir on the backend). A resolution failure aborts here,
    // before anything is spawned, so no running server is ever touched.
    const resolved = await resolveExePath(get);
    if ("error" in resolved) {
      log.notify("error", "server", `Failed to start hipfire: ${resolved.error}`);
      set({ startError: resolved.error });
      return;
    }
    const buildDir = settings.build_dir ?? "";
    const exePath = resolved.exePath;
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
    // Same protection for binary resolution: hipfire's binary is optional/
    // auto-resolving, so it's not caught by launchPrereqError above — but a
    // resolution failure must still refuse BEFORE stopServer(), or an engine
    // toggle to hipfire with no binary installed would kill a healthy server
    // and then fail to bring anything back up.
    const resolved = await resolveExePath(get);
    if ("error" in resolved) {
      log.warn("server", `reload blocked: ${resolved.error}`);
      set({ startError: resolved.error });
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
    if (argvEqual(args, loadedArgs)) return true;
    // Stale — but validate the active engine's prerequisites BEFORE tearing
    // down the healthy server. After an engine toggle, activeArgs is the NEW
    // engine's argv while loadedArgs is the OLD engine's, so this ALWAYS looks
    // stale; if the new engine can't launch (no tag set) a naive reload would
    // stop a working server and then fail the restart. Keep the old server
    // up, surface the hint, and let the chat report a clear error. A hipfire
    // binary that fails to resolve is caught the same way, one level down,
    // by reloadServer's own check below (also before it stops anything).
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

  // A server that spawns fine and dies 4 seconds into loading the model used to
  // revert the UI to "stopped" with no error anywhere: startError is only ever
  // set at SPAWN time (the prereq guard and the api.startServer catch above),
  // and the status poll just called setServer(st) on the running→stopped edge.
  //
  // The trigger is the backend's `server-exited` event, NOT that poll edge, for
  // two reasons. (1) Only the backend can tell a crash from a stop WE performed:
  // stop_server takes the child out of its slot, so the watcher stays silent,
  // whereas a poll edge can genuinely fire on a user Stop — api.stopServer()
  // and api.serverStatus() are concurrent IPC calls, so a tick can observe the
  // backend's running:false before stopServer's `finally` has written STOPPED,
  // and would then report a crash the user deliberately caused. (2) The exit
  // must not ride on the server_status RESPONSE: two independent callers poll
  // it (the effects poller and waitForServerReady, which reloadIfStale uses),
  // so a one-shot value would be consumed by whichever ticked first and lost
  // for the other — exactly during a reload-then-send, when a crash is most
  // likely. The event fans out to every listener and is emitted exactly once.
  handleServerExit: (report) => {
    const engine = engineLabel(get);
    const msg = describeServerExit(engine, report);
    // notify() logs at error level AND raises a toast, so this is visible with
    // the logs panel closed (its default) and from every surface that can start
    // a server, not just Configure's banner. The whole tail rides along as meta
    // so the console and the logs panel keep the context the headline dropped.
    log.notify("error", "server", msg, {
      pid: report.pid,
      code: report.code,
      status: report.status,
      stderr: report.stderrTail,
    });
    const currentPid = get().server.info?.pid ?? null;
    if (currentPid !== null && currentPid !== report.pid) {
      // The user already relaunched and a DIFFERENT process is live. Still
      // report the crash (the message names its pid), but never tear down the
      // state of a healthy server.
      set({ startError: msg });
      return;
    }
    // loadedArgs/loadedEngine described the now-dead process; only stopServer
    // used to clear them, so leaving them set here would let reloadIfStale
    // diff the current flags against a corpse's argv.
    set({ server: STOPPED, loadedArgs: null, loadedEngine: null, startError: msg });
  },

  // The adjacent silent failure: a process that spawns, stays alive, and never
  // reports ready. The backend used to log a warn! and return, leaving the dot
  // yellow forever with no frontend signal at all.
  handleServerProbeTimeout: (report) => {
    const currentPid = get().server.info?.pid ?? null;
    if (currentPid !== null && currentPid !== report.pid) return;
    const engine = engineLabel(get);
    const cause = pickExitCause(report.stderrTail);
    const waited =
      report.timeoutSecs >= 60
        ? `${Math.round(report.timeoutSecs / 60)}m`
        : `${report.timeoutSecs}s`;
    const msg =
      `${engine} (pid ${report.pid}) is still running but hasn't answered /health on port ${report.port} after ${waited} — it may be stuck loading.` +
      `${cause ? ` Last stderr: ${cause}.` : ""} Stop it, or check the logs panel.`;
    log.notify("warn", "server", msg, {
      pid: report.pid,
      port: report.port,
      timeout_secs: report.timeoutSecs,
      stderr: report.stderrTail,
    });
    // Deliberately does NOT clear `server`: the process is alive and might
    // still come up, so the badge must keep reflecting reality.
    set({ startError: msg });
  },
});
