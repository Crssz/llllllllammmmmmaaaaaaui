import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  api,
  type BenchRow,
  type CatalogDone,
  type CatalogProgress,
  type EngineDone,
  type EngineProgress,
  type HipfirePullDoneEvent,
  type HipfirePullProgressEvent,
} from "../lib/api";
import { log } from "../lib/logger";
import { useAppStore } from "./store";
import { activeEngine } from "./slices/serverSlice";
import type { FlagValues } from "./types";

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
      try {
        const s = await api.loadSettings();
        if (cancelled) return;
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
        if (s.build_dir) await useAppStore.getState().scanBuild(s.build_dir);
        if (s.models_dir) await useAppStore.getState().scanModels(s.models_dir);
        try {
          const loaded = await api.loadChats();
          if (!cancelled) {
            const mostRecent = [...loaded].sort((a, b) => b.updated_at - a.updated_at)[0];
            useAppStore.setState({ chats: loaded, currentChatId: mostRecent?.id ?? null });
            log.info("init", `chats loaded: ${loaded.length} sessions`);
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          log.warn("init", "chats file not loaded (likely first run)", { error: msg });
        }
        useAppStore.getState().benchLoadRuns();
        const st = await api.serverStatus();
        useAppStore.getState().setServer(st);
        log.info(
          "init",
          `initial server status: ${st.running ? `running pid=${st.info?.pid}` : "stopped"}`,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.error("init", "initial load failed", { error: msg });
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

  // Subscribe to llama-server stdout / stderr lines.
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    listen<{ stream: "stdout" | "stderr"; pid: number; line: string }>("server-log", (event) => {
      const { stream, line } = event.payload;
      if (!line) return;
      const lower = line.toLowerCase();
      const area = `llama.${stream}`;
      if (lower.includes("error") || lower.startsWith("err")) {
        log.error(area, line);
      } else if (lower.includes("warn")) {
        log.warn(area, line);
      } else {
        log.info(area, line);
      }
    })
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      })
      .catch((e) => {
        log.warn("server", "failed to subscribe to server-log events", {
          error: String(e),
        });
      });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
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
