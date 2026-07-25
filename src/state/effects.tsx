import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  api,
  type BenchRow,
  type CatalogDone,
  type CatalogProgress,
  type EngineDone,
  type EngineProgress,
  type HipfireBenchDoneEvent,
  type HipfireBenchProgressEvent,
  type HipfirePullDoneEvent,
  type HipfirePullProgressEvent,
  type Settings,
} from "../lib/api";
import { log } from "../lib/logger";
import { useAppStore } from "./store";
import { activeEngine } from "./slices/serverSlice";
import type { FlagValues } from "./types";

/**
 * Marker in the Rust error proving `jsonstore::load_json` got the unreadable
 * file out of the way (`quarantine_and_explain`, `src-tauri/src/jsonstore.rs`).
 * Its absence — a rename that lost to an antivirus scanner or a permissions
 * error, or a rejection from somewhere else entirely such as "no app data dir"
 * — means the file may still be sitting at its own path.
 */
const QUARANTINED = "moved aside to";

/**
 * Report a persisted store whose on-disk copy we could not read, and block
 * writes to it when — and only when — writing would still destroy it.
 *
 * A settings.json / chats.json that fails to read or parse used to produce only
 * a console line: the app rendered as a pristine first run and the user's real
 * settings and conversations were then destroyed by the very next write.
 *
 * The rescue now happens in Rust, before this code ever runs: `jsonstore` moves
 * the unreadable file aside to `<name>.corrupt-N.<ext>` and names that path in
 * the error arriving here as `reason`, and every write is atomic. So the store
 * path is already free, and falling back to defaults writes a *new* file that
 * cannot touch the quarantined one. What is left for the frontend is to say
 * where the data went — and to keep the old refuse-to-write guard for the one
 * case where it still prevents data loss: a quarantine that FAILED, leaving the
 * unreadable file at its own path for the next save to rename over. Blocking
 * after a successful quarantine would buy nothing and cost the user every save
 * for the rest of the session, including the settings edits made while
 * recovering. Positive proof of the rename is required rather than sniffing for
 * failure, so an error shape we don't recognise fails towards keeping the data.
 *
 * Blocking replaces the api method rather than threading a flag through
 * persist.ts because settings are saved from seven different slices; blocking at
 * the single choke point means none of them need to know. Every blocked write
 * rejects, and `persist.ts` already routes those rejections through `logFailure`
 * → a toast, so a save that didn't happen is never silent.
 */
function reportUnreadableStore(kind: "settings" | "chats", reason: string): string {
  const file = kind === "settings" ? "settings.json" : "chats.json";
  if (reason.includes(QUARANTINED)) {
    return (
      `${file} could not be read (${reason}). Nothing was lost and saving still works — this ` +
      `session just starts from defaults and writes a fresh ${file}; repair the saved copy and ` +
      `move it back to recover the old data.`
    );
  }
  const refuse = () =>
    Promise.reject(
      new Error(`${file} is unreadable and could not be quarantined — refusing to overwrite it`),
    );
  if (kind === "settings") api.saveSettings = refuse;
  else api.saveChats = refuse;
  return (
    `${file} could not be read (${reason}). It has NOT been overwritten. Nothing will be saved ` +
    `this session: quit the app, then repair or move the file and restart.`
  );
}

/**
 * Hook that wires up all long-lived side-effects of the app: settings load,
 * GGUF inspection of the active model, server-log subscription, server-status
 * + hardware polling, MCP autostart.
 *
 * Mounted exactly once near the root. Renders nothing.
 */
export function useAppEffects(initialFlags: FlagValues) {
  // Initial sync: seed flags with the FLAG_GROUPS defaults, then load settings,
  // chats, server status. Runs once on mount.
  useEffect(() => {
    let cancelled = false;
    // Seed with default flag values before settings load.
    useAppStore.setState({ flags: { ...initialFlags } });

    (async () => {
      log.info("init", "loading settings + chats…");
      // Settings, chats and the server probe each get their OWN try/catch.
      // They used to share one, so an unreadable settings.json silently took
      // the chat list, the bench history and the initial server status down
      // with it — the app then looked like a clean first run for three reasons
      // at once.
      let settings: Settings | null = null;
      try {
        settings = await api.loadSettings();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        // `load_settings` returns Settings::default() when the file is ABSENT,
        // so a rejection here always means an existing file we could not read
        // or parse — never a first run. Rust has already moved it aside by
        // now; what's left is telling the user where it went.
        log.notify("error", "init", reportUnreadableStore("settings", msg), { error: msg });
      }
      if (cancelled) return;
      if (settings) {
        const s = settings;
        // Engine axis added after some settings.json files were written (and
        // the first-run Settings::default() leaves engine_kind empty /
        // hipfire_flags null): coerce to valid defaults so the store and arg
        // builders never see gaps. Anything that isn't "hipfire" resolves to
        // the llama default.
        if (s.engine_kind !== "hipfire") s.engine_kind = "llama";
        if (typeof s.hipfire_path !== "string") s.hipfire_path = "";
        if (!s.hipfire_flags || typeof s.hipfire_flags !== "object") s.hipfire_flags = {};
        useAppStore.getState().setSettings(s);
        log.info(
          "init",
          `settings loaded: ${s.profiles.length} profiles, build_dir=${s.build_dir ?? "—"}, models_dir=${s.models_dir ?? "—"}`,
        );
        if (s.flags && typeof s.flags === "object") {
          // Migration: older builds stored spec_type as "mtp" / "draft" / "off".
          const incoming = { ...(s.flags as FlagValues) };
          if (incoming.spec_type === "mtp") {
            incoming.spec_type = "draft-mtp";
            log.info("migrate", "spec_type: mtp → draft-mtp");
          } else if (incoming.spec_type === "draft") {
            incoming.spec_type = "draft-simple";
            log.info("migrate", "spec_type: draft → draft-simple");
          } else if (incoming.spec_type === "off") {
            incoming.spec_type = "none";
            log.info("migrate", "spec_type: off → none");
          }
          useAppStore.setState((prev) => ({ flags: { ...prev.flags, ...incoming } }));
        }
        if (s.reasoning_enabled !== null && s.reasoning_enabled !== undefined) {
          useAppStore.setState({ reasoningEnabled: s.reasoning_enabled });
        }
        if (s.model_path) {
          // Route through setFlag so the model's saved per-model config (if
          // any) is restored at launch — same path every in-app model switch
          // takes. Falls back to the just-merged global flags when the model
          // has no saved slot yet (e.g. first run after upgrading).
          useAppStore.getState().setFlag("model", s.model_path);
        }
        // Scans are separate from the settings READ: a failing scan says
        // nothing about settings.json's integrity and must never be mistaken
        // for a reason to quarantine it.
        try {
          if (s.build_dir) await useAppStore.getState().scanBuild(s.build_dir);
          if (s.models_dir) await useAppStore.getState().scanModels(s.models_dir);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          log.warn("init", "initial build/models scan failed", { error: msg });
        }
      }
      if (cancelled) return;
      try {
        const loaded = await api.loadChats();
        if (!cancelled) {
          const mostRecent = [...loaded].sort((a, b) => b.updated_at - a.updated_at)[0];
          useAppStore.setState({ chats: loaded, currentChatId: mostRecent?.id ?? null });
          log.info("init", `chats loaded: ${loaded.length} sessions`);
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        // `load_chats` returns an EMPTY list for a missing file, so this was
        // never "likely first run" as it used to claim — it is always a real
        // chats.json holding real conversations that we failed to read.
        log.notify("error", "init", reportUnreadableStore("chats", msg), { error: msg });
      }
      if (cancelled) return;
      try {
        useAppStore.getState().benchLoadRuns();
        const st = await api.serverStatus();
        if (cancelled) return;
        useAppStore.getState().setServer(st);
        log.info(
          "init",
          `initial server status: ${st.running ? `running pid=${st.info?.pid}` : "stopped"}`,
        );
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log.error("init", "initial server status unavailable", { error: msg });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Inspect the GGUF whenever the model path changes: surface MTP/thinking
  // capabilities and auto-set --mmproj when a sibling exists. llama only —
  // hipfire has no /props-backed GGUF inspection (fact 5): its model
  // identity is a served tag, not a file on disk to point inspect_gguf at.
  // Gated on activeEngine (a running server wins over the toggle, same
  // dispatch chatSlice/transcribeSlice already use) so modelInfo can never
  // carry stale llama data into hipfire-active UI (Chat's reasoning tooltip,
  // the model-switcher overlay's details) — it's cleared the moment hipfire
  // becomes the active engine, and re-fetched if the user switches back.
  useEffect(() => {
    let prevModel = useAppStore.getState().flags.model as string | undefined;
    const inspect = (path: string | undefined) => {
      if (activeEngine(useAppStore.getState) === "hipfire" || !path) {
        useAppStore.getState().setModelInfo(null, null);
        return undefined;
      }
      let cancelled = false;
      log.debug("model", `inspecting GGUF: ${path}`);
      api
        .inspectGguf(path)
        .then((info) => {
          if (cancelled) return;
          useAppStore.getState().setModelInfo(info, null);
          log.info(
            "model",
            `${info.architecture ?? "?"} · MTP ${info.mtp_support ? "yes" : "no"} · mmproj ${info.mmproj_siblings.length} · thinking ${
              info.supports_thinking ? (info.thinking_style ?? "yes") : "no"
            }`,
          );
          const flags = useAppStore.getState().flags;
          // MTP detection is filename-based (see inspect_gguf) and can't see
          // heads embedded in a model whose name doesn't advertise them. A
          // false negative shouldn't silently switch the user off draft-mtp —
          // many MTP GGUFs carry the heads inline and need no drafter at all.
          // Leave the choice intact; Configure surfaces a soft caution.
          if (!info.mtp_support && flags.spec_type === "draft-mtp" && !flags.model_draft_mtp) {
            log.info(
              "model",
              "filename doesn't advertise MTP — keeping draft-mtp (drafter optional)",
            );
          }
          // Auto-fill --mmproj from a sibling projector, unless the user has
          // pinned mmproj for this model (deliberately set or cleared it).
          useAppStore.getState().autoDetectMmproj();
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          const msg = e instanceof Error ? e.message : String(e);
          useAppStore.getState().setModelInfo(null, msg);
          log.warn("model", `inspect failed: ${msg}`);
        });
      return () => {
        cancelled = true;
      };
    };

    let teardown = inspect(prevModel);
    const unsub = useAppStore.subscribe((state, prev) => {
      const modelChanged = state.flags.model !== prev.flags.model;
      // Re-evaluate only when activeEngine()'s RESOLVED value actually flips
      // (e.g. a genuine engine switch, or a running server that finally lets
      // go of the toggle it was masking) — not on every raw running/ready/
      // loadedEngine/engine_kind toggle, most of which leave activeEngine()
      // unchanged (e.g. a plain llama start/stop: engine_kind stays "llama"
      // and loadedEngine is set to "llama" in the same tick, so activeEngine
      // is "llama" both before and after). Reusing activeEngine() itself
      // (rather than re-deriving its inputs here) keeps this in lockstep with
      // serverSlice's canonical definition.
      const engineMaybeChanged = activeEngine(() => state) !== activeEngine(() => prev);
      if (!modelChanged && !engineMaybeChanged) return;
      if (teardown) teardown();
      prevModel = state.flags.model as string | undefined;
      teardown = inspect(prevModel);
    });
    return () => {
      unsub();
      if (teardown) teardown();
    };
  }, []);

  // Subscribe to engine stdout / stderr lines, and to the two events that
  // report a launch failing AFTER the spawn succeeded: `server-exited` (the
  // process died on its own) and `server-probe-timeout` (it's alive but never
  // became ready). All three share one effect so they can share the stderr tail
  // below through a closure instead of module-level mutable state.
  useEffect(() => {
    let cancelled = false;
    const unlisteners: UnlistenFn[] = [];
    const track = (p: Promise<UnlistenFn>) =>
      p
        .then((u) => {
          if (cancelled) u();
          else unlisteners.push(u);
        })
        .catch((e) =>
          log.warn("server", "failed to subscribe to server events", { error: String(e) }),
        );

    // Last few stderr lines of the process currently talking, keyed by pid so a
    // new launch starts clean. This is a dedicated ring on purpose: the lines
    // are also written to `log`, but that buffer is shared by every area and
    // capped at 500 entries (logger.ts), so a chatty model load evicts exactly
    // the lines a crash report needs. An exit code alone is near-useless
    // (llama-server returns 1 for every load failure), so this tail IS the
    // error message.
    const TAIL_MAX = 15;
    let tailPid: number | null = null;
    let tail: string[] = [];
    const tailFor = (pid: number) => (pid === tailPid ? [...tail] : []);

    track(
      listen<{ stream: "stdout" | "stderr"; pid: number; line: string }>("server-log", (event) => {
        const { stream, pid, line } = event.payload;
        if (!line) return;
        if (stream === "stderr") {
          if (pid !== tailPid) {
            tailPid = pid;
            tail = [];
          }
          tail.push(line);
          if (tail.length > TAIL_MAX) tail = tail.slice(-TAIL_MAX);
        }
        const lower = line.toLowerCase();
        const area = `llama.${stream}`;
        if (lower.includes("error") || lower.startsWith("err")) {
          log.error(area, line);
        } else if (lower.includes("warn")) {
          log.warn(area, line);
        } else {
          log.info(area, line);
        }
      }),
    );

    track(
      listen<{ pid: number; code: number | null; status: string }>("server-exited", (event) => {
        const { pid, code, status } = event.payload;
        useAppStore.getState().handleServerExit({
          pid,
          code,
          status,
          stderrTail: tailFor(pid),
        });
      }),
    );

    track(
      listen<{ pid: number; port: number; timeout_secs: number }>(
        "server-probe-timeout",
        (event) => {
          const { pid, port, timeout_secs } = event.payload;
          useAppStore.getState().handleServerProbeTimeout({
            pid,
            port,
            timeoutSecs: timeout_secs,
            stderrTail: tailFor(pid),
          });
        },
      ),
    );

    return () => {
      cancelled = true;
      for (const u of unlisteners) u();
    };
  }, []);

  // Subscribe to llama-bench progress (stderr) + terminal result events.
  useEffect(() => {
    let cancelled = false;
    const unlisteners: UnlistenFn[] = [];
    const track = (p: Promise<UnlistenFn>) =>
      p
        .then((u) => {
          if (cancelled) u();
          else unlisteners.push(u);
        })
        .catch((e) =>
          log.warn("bench", "failed to subscribe to bench events", { error: String(e) }),
        );

    track(
      listen<{ generation: number; line: string }>("bench-progress", (event) => {
        useAppStore.getState().benchOnProgress(event.payload.line);
      }),
    );
    track(
      listen<{
        generation: number;
        ok: boolean;
        cancelled: boolean;
        error: string | null;
        rows: BenchRow[];
      }>("bench-done", (event) => {
        useAppStore.getState().benchOnDone(event.payload);
      }),
    );
    return () => {
      cancelled = true;
      for (const u of unlisteners) u();
    };
  }, []);

  // Subscribe to engine download progress + terminal result events.
  useEffect(() => {
    let cancelled = false;
    const unlisteners: UnlistenFn[] = [];
    const track = (p: Promise<UnlistenFn>) =>
      p
        .then((u) => {
          if (cancelled) u();
          else unlisteners.push(u);
        })
        .catch((e) =>
          log.warn("engines", "failed to subscribe to engine events", { error: String(e) }),
        );

    track(
      listen<EngineProgress>("engine-progress", (event) => {
        useAppStore.getState().engineOnProgress(event.payload);
      }),
    );
    track(
      listen<EngineDone>("engine-done", (event) => {
        useAppStore.getState().engineOnDone(event.payload);
      }),
    );
    return () => {
      cancelled = true;
      for (const u of unlisteners) u();
    };
  }, []);

  // Subscribe to model-catalog download progress + terminal result events.
  useEffect(() => {
    let cancelled = false;
    const unlisteners: UnlistenFn[] = [];
    const track = (p: Promise<UnlistenFn>) =>
      p
        .then((u) => {
          if (cancelled) u();
          else unlisteners.push(u);
        })
        .catch((e) =>
          log.warn("catalog", "failed to subscribe to catalog events", { error: String(e) }),
        );

    track(
      listen<CatalogProgress>("catalog-progress", (event) => {
        useAppStore.getState().catalogOnProgress(event.payload);
      }),
    );
    track(
      listen<CatalogDone>("catalog-done", (event) => {
        useAppStore.getState().catalogOnDone(event.payload);
      }),
    );
    return () => {
      cancelled = true;
      for (const u of unlisteners) u();
    };
  }, []);

  // Subscribe to hipfire-pull progress + terminal result events. Lifted here
  // (rather than a listen() effect inside HipfirePullPanel) so a pull — a
  // long-running HuggingFace download, up to 82GB in the catalog — keeps
  // updating the store and its done event still gets handled even while the
  // panel that started it isn't mounted.
  useEffect(() => {
    let cancelled = false;
    const unlisteners: UnlistenFn[] = [];
    const track = (p: Promise<UnlistenFn>) =>
      p
        .then((u) => {
          if (cancelled) u();
          else unlisteners.push(u);
        })
        .catch((e) =>
          log.warn("hipfire", "failed to subscribe to hipfire-pull events", { error: String(e) }),
        );

    track(
      listen<HipfirePullProgressEvent>("hipfire-pull-progress", (event) => {
        useAppStore.getState().hipfirePullOnProgress(event.payload.line);
      }),
    );
    track(
      listen<HipfirePullDoneEvent>("hipfire-pull-done", (event) => {
        useAppStore.getState().hipfirePullOnDone(event.payload);
      }),
    );
    return () => {
      cancelled = true;
      for (const u of unlisteners) u();
    };
  }, []);

  // Subscribe to hipfire-bench progress + terminal result events. Lifted here
  // (rather than a listen() effect inside BenchScreen) so a run — which can
  // take a while across a prefill sweep and multiple runs — keeps updating
  // the store and its done event still gets handled even while Bench isn't
  // the active tab.
  useEffect(() => {
    let cancelled = false;
    const unlisteners: UnlistenFn[] = [];
    const track = (p: Promise<UnlistenFn>) =>
      p
        .then((u) => {
          if (cancelled) u();
          else unlisteners.push(u);
        })
        .catch((e) =>
          log.warn("hipfire", "failed to subscribe to hipfire-bench events", { error: String(e) }),
        );

    track(
      listen<HipfireBenchProgressEvent>("hipfire-bench-progress", (event) => {
        useAppStore.getState().hipfireBenchOnProgress(event.payload.line);
      }),
    );
    track(
      listen<HipfireBenchDoneEvent>("hipfire-bench-done", (event) => {
        useAppStore.getState().hipfireBenchOnDone(event.payload);
      }),
    );
    return () => {
      cancelled = true;
      for (const u of unlisteners) u();
    };
  }, []);

  // Poll server status. While the readiness probe is racing (running but not
  // yet ready) we tick faster so the dot turns green promptly.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const st = await api.serverStatus();
        if (cancelled) return;
        const prev = useAppStore.getState().server;
        if (
          prev.running !== st.running ||
          prev.ready !== st.ready ||
          prev.info?.pid !== st.info?.pid
        ) {
          useAppStore.getState().setServer(st);
        }
        const delay = st.running && !st.ready ? 400 : 2000;
        timer = setTimeout(tick, delay);
      } catch {
        if (!cancelled) timer = setTimeout(tick, 2000);
      }
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Poll hardware snapshot every 1s.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const snap = await api.hwSnapshot();
        if (cancelled) return;
        useAppStore.getState().applyHwSnapshot(snap);
      } catch {
        /* ignore */
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Autostart any MCP servers flagged for autostart, once after settings load.
  useEffect(() => {
    let started = false;
    const tryStart = async () => {
      if (started) return;
      const servers = useAppStore.getState().settings.mcp_servers;
      if (!servers || servers.length === 0) return;
      started = true;
      await useAppStore.getState().mcpRefreshStatus();
      for (const s of servers) {
        if (s.autostart) {
          useAppStore
            .getState()
            .mcpConnect(s.id)
            .catch(() => {});
        }
      }
    };
    tryStart();
    const unsub = useAppStore.subscribe((state, prev) => {
      if (state.settings.mcp_servers === prev.settings.mcp_servers) return;
      tryStart();
    });
    return () => unsub();
  }, []);
}

export function AppEffects({ initialFlags }: { initialFlags: FlagValues }) {
  useAppEffects(initialFlags);
  return null;
}
