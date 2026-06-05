import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "../lib/api";
import { log } from "../lib/logger";
import { useAppStore } from "./store";
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
          useAppStore.setState((prev) => ({
            flags: { ...prev.flags, model: s.model_path as string },
          }));
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

  // Inspect the GGUF whenever the model path changes. Auto-demote draft-mtp
  // when the model lacks MTP heads; auto-set --mmproj when a sibling exists.
  useEffect(() => {
    let prevModel = useAppStore.getState().flags.model as string | undefined;
    const inspect = (path: string | undefined) => {
      if (!path) {
        useAppStore.getState().setModelInfo(null, null);
        return;
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
            `${info.architecture ?? "?"} · MTP ${info.mtp_support ? "yes" : "no"} · mmproj ${info.mmproj_siblings.length}`,
          );
          const flags = useAppStore.getState().flags;
          if (!info.mtp_support && flags.spec_type === "draft-mtp") {
            log.warn("model", "model lacks MTP heads — disabling speculative decoding");
            useAppStore.getState().setFlag("spec_type", "none");
          }
          const sibling = info.mmproj_siblings[0];
          const currentMmproj = (flags.mmproj as string) || "";
          const currentIsValid = currentMmproj && info.mmproj_siblings.includes(currentMmproj);
          if (sibling && !currentIsValid) {
            log.info("model", `auto-set --mmproj: ${sibling}`);
            useAppStore.getState().setFlag("mmproj", sibling);
          } else if (!sibling && currentMmproj) {
            log.info("model", "clearing --mmproj (no sibling in model dir)");
            useAppStore.getState().setFlag("mmproj", "");
          }
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
      const next = state.flags.model as string | undefined;
      const old = prev.flags.model as string | undefined;
      if (next === old) return;
      if (teardown) teardown();
      prevModel = next;
      teardown = inspect(next);
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
