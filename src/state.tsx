import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  api,
  type BuildInfo,
  type ChatSession,
  type GgufInfo,
  type HwSnapshot,
  type ModelsScan,
  type RunningInfo,
  type SavedProfile,
  type Settings,
  type StoredChatMessage,
} from "./lib/api";
import { log, logFailure } from "./lib/logger";

type FlagValues = Record<string, string | number | boolean>;

export type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
  time: number;
  reasoning?: string;
  meta?: { tps?: number; tokens?: number };
};

function toView(msgs: StoredChatMessage[]): ChatMessage[] {
  return msgs.map((m) => ({
    role: m.role,
    content: m.content,
    time: m.time,
    reasoning: m.reasoning ?? undefined,
    meta:
      m.tps != null || m.tokens != null
        ? { tps: m.tps ?? undefined, tokens: m.tokens ?? undefined }
        : undefined,
  }));
}

function fromView(m: ChatMessage): StoredChatMessage {
  return {
    role: m.role,
    content: m.content,
    time: m.time,
    tps: m.meta?.tps ?? null,
    tokens: m.meta?.tokens ?? null,
    reasoning: m.reasoning ?? null,
  };
}

// Split raw content text into visible content and reasoning by stripping any
// <think>...</think> spans. Handles an unclosed final <think> by treating
// everything after it as reasoning so partial streams render correctly.
export function splitThink(raw: string): { content: string; reasoning: string } {
  let reasoning = "";
  let content = "";
  let i = 0;
  const OPEN = "<think>";
  const CLOSE = "</think>";
  while (i < raw.length) {
    const open = raw.indexOf(OPEN, i);
    if (open === -1) {
      content += raw.slice(i);
      break;
    }
    content += raw.slice(i, open);
    const close = raw.indexOf(CLOSE, open + OPEN.length);
    if (close === -1) {
      reasoning += raw.slice(open + OPEN.length);
      break;
    }
    reasoning += raw.slice(open + OPEN.length, close);
    i = close + CLOSE.length;
  }
  return { content: content.trim(), reasoning: reasoning.trim() };
}

function newChatId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function deriveTitle(messages: StoredChatMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  if (!first) return "New chat";
  const t = first.content.trim().replace(/\s+/g, " ");
  return t.length > 48 ? t.slice(0, 47) + "…" : t || "New chat";
}

type AppState = {
  // settings & persistence
  settings: Settings;

  // build
  build: BuildInfo | null;
  scanning: boolean;
  scanError: string | null;
  pickBuildDir: () => Promise<void>;
  setBuildDir: (dir: string) => Promise<void>;
  rescan: () => Promise<void>;
  clearRecent: () => Promise<void>;

  // server
  server: { running: boolean; ready: boolean; info: RunningInfo | null };
  startError: string | null;
  startServer: (args: string[]) => Promise<void>;
  stopServer: () => Promise<void>;

  // flags
  flags: FlagValues;
  setFlag: (key: string, value: string | number | boolean) => void;
  resetFlags: (values: FlagValues) => void;
  pickModel: () => Promise<void>;
  agency: "manual" | "suggest" | "auto";
  setAgency: (a: "manual" | "suggest" | "auto") => void;

  // models library
  models: ModelsScan | null;
  modelsScanning: boolean;
  modelsScanError: string | null;
  // GGUF inspection of the currently-loaded --model path
  modelInfo: GgufInfo | null;
  modelInfoError: string | null;
  pickModelsDir: () => Promise<void>;
  setModelsDir: (dir: string) => Promise<void>;
  rescanModels: () => Promise<void>;
  clearModelsRecent: () => Promise<void>;
  loadModelPath: (path: string) => void;

  // profiles
  saveProfile: (name: string) => Promise<void>;
  loadProfile: (id: string) => void;
  deleteProfile: (id: string) => Promise<void>;

  // hardware
  hw: HwSnapshot | null;
  hwSeries: {
    cpu: number[];
    ram: number[];
    vram: number[];
    gpu: number[];
  };

  // chat
  chats: ChatSession[];
  currentChatId: string | null;
  currentChat: ChatSession | null;
  chatMessages: ChatMessage[];
  chatPending: boolean;
  chatError: string | null;
  reasoningEnabled: boolean;
  setReasoningEnabled: (v: boolean) => void;
  sendChat: (content: string) => Promise<void>;
  cancelChat: () => void;
  newChat: () => void;
  selectChat: (id: string) => void;
  deleteChat: (id: string) => void;
  togglePinChat: (id: string) => void;
  renameChat: (id: string, title: string) => void;
  editMessage: (chatId: string, index: number, content: string) => void;
  deleteMessage: (chatId: string, index: number) => void;
  resendFromMessage: (chatId: string, index: number) => Promise<void>;
};

const Ctx = createContext<AppState | null>(null);
const SERIES_LEN = 32;

function pushSeries(buf: number[], v: number): number[] {
  const out = buf.length >= SERIES_LEN ? buf.slice(buf.length - SERIES_LEN + 1) : buf.slice();
  out.push(v);
  return out;
}

const EMPTY_SETTINGS: Settings = {
  build_dir: null,
  recent_dirs: [],
  model_path: null,
  flags: {},
  models_dir: null,
  models_recent: [],
  profiles: [],
  reasoning_enabled: null,
};

export function AppStateProvider({
  children,
  initialFlags,
}: {
  children: ReactNode;
  initialFlags: FlagValues;
}) {
  const [settings, setSettings] = useState<Settings>(EMPTY_SETTINGS);
  const [build, setBuild] = useState<BuildInfo | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [server, setServer] = useState<AppState["server"]>({
    running: false,
    ready: false,
    info: null,
  });
  const [flags, setFlags] = useState<FlagValues>({ ...initialFlags });
  const [agency, setAgency] = useState<"manual" | "suggest" | "auto">("manual");
  const [startError, setStartError] = useState<string | null>(null);

  const [models, setModels] = useState<ModelsScan | null>(null);
  const [modelsScanning, setModelsScanning] = useState(false);
  const [modelsScanError, setModelsScanError] = useState<string | null>(null);
  const [modelInfo, setModelInfo] = useState<GgufInfo | null>(null);
  const [modelInfoError, setModelInfoError] = useState<string | null>(null);

  const [hw, setHw] = useState<HwSnapshot | null>(null);
  const [hwSeries, setHwSeries] = useState({
    cpu: [] as number[],
    ram: [] as number[],
    vram: [] as number[],
    gpu: [] as number[],
  });

  const [chats, setChats] = useState<ChatSession[]>([]);
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [chatPending, setChatPending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [reasoningEnabled, setReasoningEnabledState] = useState(true);
  const chatAbortRef = useRef<AbortController | null>(null);

  const persistChats = useCallback((next: ChatSession[]) => {
    api.saveChats(next).catch(logFailure("persist", "saveChats"));
  }, []);

  const buildScanRef = useRef<string | null>(null);
  const modelsScanRef = useRef<string | null>(null);

  const doScanBuild = useCallback(async (dir: string) => {
    buildScanRef.current = dir;
    setScanning(true);
    setScanError(null);
    log.info("scan-build", `scan starting`, { dir });
    try {
      const info = await api.scanBuild(dir);
      if (buildScanRef.current === dir) {
        setBuild(info);
        log.info(
          "scan-build",
          `done: detected=${info.detected} version=${info.version ?? "?"} binaries=${info.binaries.length}`,
          { backends: info.backend_badges, resolved: info.resolved_path },
        );
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error("scan-build", `scan failed`, { error: msg });
      if (buildScanRef.current === dir) setScanError(msg);
    } finally {
      if (buildScanRef.current === dir) setScanning(false);
    }
  }, []);

  const doScanModels = useCallback(async (dir: string) => {
    modelsScanRef.current = dir;
    setModelsScanning(true);
    setModelsScanError(null);
    log.info("scan-models", `scan starting`, { dir });
    try {
      const info = await api.scanModels(dir);
      if (modelsScanRef.current === dir) {
        setModels(info);
        log.info(
          "scan-models",
          `done: owners=${info.owners} models=${info.count} total=${info.total_gb.toFixed(1)} GB`,
        );
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error("scan-models", `scan failed`, { error: msg });
      if (modelsScanRef.current === dir) setModelsScanError(msg);
    } finally {
      if (modelsScanRef.current === dir) setModelsScanning(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    let cancelled = false;
    (async () => {
      log.info("init", "loading settings + chats…");
      try {
        const s = await api.loadSettings();
        if (cancelled) return;
        setSettings(s);
        log.info(
          "init",
          `settings loaded: ${s.profiles.length} profiles, build_dir=${s.build_dir ?? "—"}, models_dir=${s.models_dir ?? "—"}`,
        );
        if (s.flags && typeof s.flags === "object") {
          // Migration: older builds stored spec_type as "mtp" / "draft" / "off".
          // llama.cpp renamed these to "draft-mtp" / "draft-simple" / "none".
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
          setFlags((f) => ({ ...f, ...incoming }));
        }
        if (s.reasoning_enabled !== null && s.reasoning_enabled !== undefined) {
          setReasoningEnabledState(s.reasoning_enabled);
        }
        if (s.model_path) {
          setFlags((f) => ({ ...f, model: s.model_path as string }));
        }
        if (s.build_dir) await doScanBuild(s.build_dir);
        if (s.models_dir) await doScanModels(s.models_dir);
        try {
          const loaded = await api.loadChats();
          if (!cancelled) {
            setChats(loaded);
            const mostRecent = [...loaded].sort((a, b) => b.updated_at - a.updated_at)[0];
            setCurrentChatId(mostRecent?.id ?? null);
            log.info("init", `chats loaded: ${loaded.length} sessions`);
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          log.warn("init", "chats file not loaded (likely first run)", { error: msg });
        }
        const st = await api.serverStatus();
        setServer(st);
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
  }, [doScanBuild, doScanModels]);

  // Inspect the GGUF whenever the model path changes. If the file isn't
  // MTP-capable, automatically demote spec_type away from "draft-mtp" so the
  // user doesn't get a server start failure.
  useEffect(() => {
    const path = flags.model as string | undefined;
    if (!path) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setModelInfo(null);
      setModelInfoError(null);
      return;
    }
    let cancelled = false;
    log.debug("model", `inspecting GGUF: ${path}`);
    api
      .inspectGguf(path)
      .then((info) => {
        if (cancelled) return;
        setModelInfo(info);
        setModelInfoError(null);
        log.info(
          "model",
          `${info.architecture ?? "?"} · MTP ${info.mtp_support ? "yes" : "no"} · mmproj ${info.mmproj_siblings.length}`,
        );
        // Auto-disable MTP speculation if not supported.
        if (!info.mtp_support && flags.spec_type === "draft-mtp") {
          log.warn("model", "model lacks MTP heads — disabling speculative decoding");
          setFlags((prev) => {
            const next = { ...prev, spec_type: "none" };
            api
              .saveSettings({ ...settings, flags: next })
              .catch(logFailure("persist", "saveSettings"));
            return next;
          });
        }
        // Auto-set --mmproj if a sibling exists; clear if none. If the current
        // mmproj is still valid for the new directory, leave it alone.
        const sibling = info.mmproj_siblings[0];
        const currentMmproj = (flags.mmproj as string) || "";
        const currentIsValid = currentMmproj && info.mmproj_siblings.includes(currentMmproj);
        if (sibling && !currentIsValid) {
          log.info("model", `auto-set --mmproj: ${sibling}`);
          setFlags((prev) => {
            const next = { ...prev, mmproj: sibling };
            api
              .saveSettings({ ...settings, flags: next })
              .catch(logFailure("persist", "saveSettings"));
            return next;
          });
        } else if (!sibling && currentMmproj) {
          log.info("model", "clearing --mmproj (no sibling in model dir)");
          setFlags((prev) => {
            const next = { ...prev, mmproj: "" };
            api
              .saveSettings({ ...settings, flags: next })
              .catch(logFailure("persist", "saveSettings"));
            return next;
          });
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setModelInfo(null);
        setModelInfoError(msg);
        log.warn("model", `inspect failed: ${msg}`);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flags.model]);

  // Subscribe to llama-server stdout / stderr lines piped up by the Rust side.
  // Each line is funneled into the existing log ring buffer so LogsPanel
  // renders them inline with the app's own logs. Heuristic level routing:
  // lines with "error" go to error, "warn" to warn, everything else to info.
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
  // yet ready) we tick faster so the dot turns green promptly; once ready, fall
  // back to the slower 2s cadence used just for liveness.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const st = await api.serverStatus();
        if (cancelled) return;
        setServer((prev) =>
          prev.running !== st.running || prev.ready !== st.ready || prev.info?.pid !== st.info?.pid
            ? st
            : prev,
        );
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

  // Poll hardware snapshot every 1s
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const snap = await api.hwSnapshot();
        if (cancelled) return;
        setHw(snap);
        const gpu0 = snap.gpus[0];
        setHwSeries((s) => ({
          cpu: pushSeries(s.cpu, snap.cpu_util),
          ram: pushSeries(
            s.ram,
            snap.ram_total_gb > 0 ? (snap.ram_used_gb / snap.ram_total_gb) * 100 : 0,
          ),
          vram: pushSeries(
            s.vram,
            gpu0 && gpu0.vram_total_gb > 0 ? (gpu0.vram_used_gb / gpu0.vram_total_gb) * 100 : 0,
          ),
          // util may be null on HIP — keep the series flat at 0 but the
          // Hardware screen renders the value itself as "—" so the user
          // knows the backend can't report it.
          gpu: pushSeries(s.gpu, gpu0?.util ?? 0),
        }));
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

  const persistFlags = useCallback(
    (next: FlagValues) => {
      api.saveSettings({ ...settings, flags: next }).catch(logFailure("persist", "saveSettings"));
    },
    [settings],
  );

  const setReasoningEnabled = useCallback((v: boolean) => {
    setReasoningEnabledState(v);
    setSettings((s) => {
      const updated = { ...s, reasoning_enabled: v };
      api.saveSettings(updated).catch(logFailure("persist", "saveSettings"));
      return updated;
    });
    log.info("chat", `enable_thinking: ${v ? "on" : "off"}`);
  }, []);

  const setFlag = useCallback(
    (key: string, value: string | number | boolean) => {
      setFlags((prev) => {
        const next = { ...prev, [key]: value };
        persistFlags(next);
        if (key === "model" && typeof value === "string") {
          setSettings((s) => {
            const updated = { ...s, model_path: value };
            api
              .saveSettings({ ...updated, flags: next })
              .catch(logFailure("persist", "saveSettings"));
            return updated;
          });
        }
        return next;
      });
    },
    [persistFlags],
  );

  const resetFlags = useCallback((values: FlagValues) => {
    setFlags(values);
    setSettings((s) => {
      const updated = { ...s, flags: values };
      api.saveSettings(updated).catch(logFailure("persist", "saveSettings"));
      return updated;
    });
  }, []);

  const setBuildDir = useCallback(
    async (dir: string) => {
      const next = await api.addRecentDir(dir);
      setSettings(next);
      await doScanBuild(dir);
    },
    [doScanBuild],
  );

  const pickBuildDir = useCallback(async () => {
    const picked = await api.pickFolder("Select llama.cpp build directory");
    if (picked) await setBuildDir(picked);
  }, [setBuildDir]);

  const rescan = useCallback(async () => {
    if (settings.build_dir) await doScanBuild(settings.build_dir);
  }, [settings.build_dir, doScanBuild]);

  const clearRecent = useCallback(async () => {
    const updated: Settings = { ...settings, recent_dirs: [] };
    await api.saveSettings(updated);
    setSettings(updated);
  }, [settings]);

  const setModelsDir = useCallback(
    async (dir: string) => {
      const next = await api.addRecentModelsDir(dir);
      setSettings(next);
      await doScanModels(dir);
    },
    [doScanModels],
  );

  const pickModelsDir = useCallback(async () => {
    const picked = await api.pickFolder("Select models directory");
    if (picked) await setModelsDir(picked);
  }, [setModelsDir]);

  const rescanModels = useCallback(async () => {
    if (settings.models_dir) await doScanModels(settings.models_dir);
  }, [settings.models_dir, doScanModels]);

  const clearModelsRecent = useCallback(async () => {
    const updated: Settings = { ...settings, models_recent: [] };
    await api.saveSettings(updated);
    setSettings(updated);
  }, [settings]);

  const loadModelPath = useCallback(
    (path: string) => {
      setFlag("model", path);
    },
    [setFlag],
  );

  const pickModel = useCallback(async () => {
    const picked = await api.pickFile();
    if (picked) setFlag("model", picked);
  }, [setFlag]);

  const startServer = useCallback(
    async (args: string[]) => {
      if (!settings.build_dir) {
        log.warn("server", "start blocked: no build_dir set");
        setStartError("Pick a llama.cpp build directory first.");
        return;
      }
      setStartError(null);
      log.info("server", `starting llama-server`, {
        build_dir: settings.build_dir,
        arg_count: args.length,
      });
      log.debug("server", `argv: ${args.join(" ")}`);
      try {
        const info = await api.startServer(settings.build_dir, args);
        // Process is up but the model hasn't loaded yet; the poller will flip
        // `ready` to true once /health returns 200.
        setServer({ running: true, ready: false, info });
        log.info("server", `started: pid=${info.pid} port=${info.port} (loading model…)`, {
          binary: info.binary,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log.error("server", `start failed`, { error: msg });
        setStartError(msg);
      }
    },
    [settings.build_dir],
  );

  const stopServer = useCallback(async () => {
    log.info("server", "stop requested");
    try {
      await api.stopServer();
      log.info("server", "stopped");
    } catch (e: unknown) {
      log.error("server", "stop failed", { error: String(e) });
    } finally {
      setServer({ running: false, ready: false, info: null });
    }
  }, []);

  // ── Profiles ─────────────────────────────────────────────────────────────
  const saveProfile = useCallback(
    async (name: string) => {
      const profile: SavedProfile = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: name || "Untitled profile",
        created_at: Date.now(),
        flags: flags as Record<string, unknown>,
        model_path: (flags.model as string) || settings.model_path || null,
        agency,
      };
      const updated: Settings = {
        ...settings,
        profiles: [profile, ...settings.profiles].slice(0, 50),
      };
      await api.saveSettings(updated);
      setSettings(updated);
    },
    [flags, settings, agency],
  );

  const loadProfile = useCallback(
    (id: string) => {
      const p = settings.profiles.find((pr) => pr.id === id);
      if (!p) return;
      const f = { ...flags, ...(p.flags as FlagValues) };
      if (p.model_path) f.model = p.model_path;
      resetFlags(f);
      if (p.agency === "manual" || p.agency === "suggest" || p.agency === "auto") {
        setAgency(p.agency);
      }
    },
    [settings.profiles, flags, resetFlags],
  );

  const deleteProfile = useCallback(
    async (id: string) => {
      const updated: Settings = {
        ...settings,
        profiles: settings.profiles.filter((p) => p.id !== id),
      };
      await api.saveSettings(updated);
      setSettings(updated);
    },
    [settings],
  );

  // ── Chat sessions ───────────────────────────────────────────────────────
  const currentChat = useMemo(
    () => chats.find((c) => c.id === currentChatId) ?? null,
    [chats, currentChatId],
  );
  const chatMessages = useMemo(() => toView(currentChat?.messages ?? []), [currentChat]);

  const newChat = useCallback(() => {
    const id = newChatId();
    const now = Date.now();
    const session: ChatSession = {
      id,
      title: "New chat",
      created_at: now,
      updated_at: now,
      pinned: false,
      messages: [],
    };
    setChats((prev) => {
      const next = [session, ...prev];
      persistChats(next);
      return next;
    });
    setCurrentChatId(id);
    setChatError(null);
    log.info("chat", `new session: ${id}`);
  }, [persistChats]);

  const selectChat = useCallback((id: string) => {
    setCurrentChatId(id);
    setChatError(null);
  }, []);

  const deleteChat = useCallback(
    (id: string) => {
      log.info("chat", `delete session ${id}`);
      setChats((prev) => {
        const next = prev.filter((c) => c.id !== id);
        persistChats(next);
        return next;
      });
      setCurrentChatId((cur) => {
        if (cur !== id) return cur;
        const fallback = chats
          .filter((c) => c.id !== id)
          .sort((a, b) => b.updated_at - a.updated_at)[0];
        return fallback?.id ?? null;
      });
    },
    [chats, persistChats],
  );

  const togglePinChat = useCallback(
    (id: string) => {
      setChats((prev) => {
        const next = prev.map((c) =>
          c.id === id ? { ...c, pinned: !c.pinned, updated_at: c.updated_at } : c,
        );
        persistChats(next);
        return next;
      });
    },
    [persistChats],
  );

  const renameChat = useCallback(
    (id: string, title: string) => {
      setChats((prev) => {
        const next = prev.map((c) => (c.id === id ? { ...c, title: title || "Untitled" } : c));
        persistChats(next);
        return next;
      });
    },
    [persistChats],
  );

  // Update an in-progress assistant message without persisting (called many
  // times per second while streaming). Persist happens once on completion.
  const patchAssistantContent = useCallback(
    (chatId: string, content: string, reasoning: string | null) => {
      setChats((prev) =>
        prev.map((c) => {
          if (c.id !== chatId) return c;
          const last = c.messages[c.messages.length - 1];
          if (!last || last.role !== "assistant") return c;
          const newMessages = c.messages.slice(0, -1).concat({
            ...last,
            content,
            reasoning,
          });
          return { ...c, messages: newMessages, updated_at: Date.now() };
        }),
      );
    },
    [],
  );

  const finalizeAssistant = useCallback(
    (
      chatId: string,
      content: string,
      reasoning: string | null,
      tokens: number | null,
      tps: number | null,
    ) => {
      setChats((prev) => {
        const next = prev.map((c) => {
          if (c.id !== chatId) return c;
          const last = c.messages[c.messages.length - 1];
          if (!last || last.role !== "assistant") return c;
          const newLast: StoredChatMessage = {
            ...last,
            content,
            reasoning,
            tokens,
            tps,
            time: last.time,
          };
          return {
            ...c,
            messages: c.messages.slice(0, -1).concat(newLast),
            updated_at: Date.now(),
          };
        });
        persistChats(next);
        return next;
      });
    },
    [persistChats],
  );

  // Shared streaming helper. `baseMessages` is the conversation history that
  // should be sent to the model; this helper appends a streaming assistant
  // placeholder, runs the SSE loop, and finalizes the message.
  const streamReply = useCallback(
    async (session: ChatSession, baseMessages: StoredChatMessage[]) => {
      if (!server.running || !server.info) {
        setChatError("Start llama-server on the Configure tab first.");
        return;
      }
      if (!server.ready) {
        setChatError("Server is still loading the model — give it a moment.");
        return;
      }
      setChatError(null);

      const placeholderAssistant: StoredChatMessage = {
        role: "assistant",
        content: "",
        time: Date.now(),
      };
      const updated: ChatSession = {
        ...session,
        title: session.messages.length === 0 ? deriveTitle(baseMessages) : session.title,
        updated_at: Date.now(),
        messages: [...baseMessages, placeholderAssistant],
      };

      setChats((prev) => {
        const others = prev.filter((c) => c.id !== updated.id);
        const next = [updated, ...others];
        persistChats(next);
        return next;
      });
      setCurrentChatId(updated.id);
      setChatPending(true);

      const url = `http://127.0.0.1:${server.info.port}/v1/chat/completions`;
      const t0 = performance.now();
      const abort = new AbortController();
      chatAbortRef.current = abort;

      log.info("chat", `→ ${url} (stream)`, {
        chat: updated.id,
        history_len: baseMessages.length,
      });

      // Accumulate raw deltas. `rawContent` is the OpenAI `delta.content`
      // stream — may contain inline <think> tags. `streamedReasoning` is the
      // separate `delta.reasoning_content` channel emitted by llama.cpp when
      // --reasoning-format extracts the think block server-side.
      let rawContent = "";
      let streamedReasoning = "";
      let usageTokens: number | null = null;
      let streamError: string | null = null;

      // chat_template_kwargs is only safe to send when the server is running
      // with --jinja (and the Jinja template inspects enable_thinking). For
      // models that don't use the kwarg, the template just ignores it. We
      // gate on flags.jinja so older llama-server builds without the kwarg
      // path don't reject the request.
      const useTemplateKwargs = flags.jinja === true;
      const body: Record<string, unknown> = {
        model: "local",
        stream: true,
        stream_options: { include_usage: true },
        messages: baseMessages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      };
      if (useTemplateKwargs) {
        body.chat_template_kwargs = { enable_thinking: reasoningEnabled };
        log.debug("chat", `chat_template_kwargs: enable_thinking=${reasoningEnabled}`);
      }

      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: abort.signal,
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status}${body ? `: ${body}` : ""}`);
        }
        if (!res.body) {
          throw new Error("response has no body");
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let frameCount = 0;
        let nextFlush = 0;

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let nl: number;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const raw = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            const line = raw.trim();
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (payload === "[DONE]") {
              continue;
            }
            try {
              const chunk = JSON.parse(payload);
              if (chunk.error) {
                throw new Error(
                  typeof chunk.error === "string"
                    ? chunk.error
                    : chunk.error.message || JSON.stringify(chunk.error),
                );
              }
              const delta = chunk.choices?.[0]?.delta ?? {};
              const contentDelta: unknown = delta.content;
              const reasoningDelta: unknown = delta.reasoning_content;
              let touched = false;
              if (typeof contentDelta === "string" && contentDelta.length > 0) {
                rawContent += contentDelta;
                touched = true;
              }
              if (typeof reasoningDelta === "string" && reasoningDelta.length > 0) {
                streamedReasoning += reasoningDelta;
                touched = true;
              }
              if (touched) {
                frameCount++;
                const now = performance.now();
                if (now >= nextFlush) {
                  const split = splitThink(rawContent);
                  const reasoning = (
                    streamedReasoning + (split.reasoning ? "\n" + split.reasoning : "")
                  ).trim();
                  patchAssistantContent(updated.id, split.content, reasoning || null);
                  nextFlush = now + 33;
                }
              }
              const u = chunk.usage;
              if (u && typeof u.completion_tokens === "number") {
                usageTokens = u.completion_tokens;
              }
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              log.warn("chat", `SSE parse / payload error`, { line, error: msg });
              streamError = msg;
            }
          }
        }

        // Flush whatever's left in the buffer one last time.
        if (buffer.trim().startsWith("data:")) {
          // ignore trailing partial frame
        }

        log.debug("chat", `stream finished after ${frameCount} delta frames`);
      } catch (e: unknown) {
        if ((e as { name?: string })?.name === "AbortError") {
          log.info("chat", "request aborted by user");
        } else {
          const msg = e instanceof Error ? e.message : String(e);
          streamError = msg;
          log.error("chat", "request failed", { error: msg, url });
        }
      } finally {
        chatAbortRef.current = null;
        const elapsed = (performance.now() - t0) / 1000;
        const tps = usageTokens && elapsed > 0 ? usageTokens / elapsed : null;
        log.info(
          "chat",
          `← ${usageTokens ?? "?"} tokens in ${elapsed.toFixed(2)}s (${tps ? tps.toFixed(1) : "?"} tok/s)`,
        );

        // Final parse: pull think blocks out of rawContent and combine with
        // any reasoning_content that streamed in parallel.
        const split = splitThink(rawContent);
        const reasoning =
          (streamedReasoning + (split.reasoning ? "\n" + split.reasoning : "")).trim() || null;
        // If we never produced any content and hit an error, replace the
        // placeholder with the error so the user sees something.
        if (!split.content && !reasoning && streamError) {
          finalizeAssistant(updated.id, `⚠️ ${streamError}`, null, usageTokens, tps);
          setChatError(streamError);
        } else {
          finalizeAssistant(updated.id, split.content, reasoning, usageTokens, tps);
          if (streamError) setChatError(streamError);
        }
        setChatPending(false);
      }
    },
    [server, persistChats, patchAssistantContent, finalizeAssistant, flags.jinja, reasoningEnabled],
  );

  const sendChat = useCallback(
    async (content: string) => {
      const text = content.trim();
      if (!text) return;
      if (!server.running || !server.info) {
        setChatError("Start llama-server on the Configure tab first.");
        return;
      }

      // Ensure we have a current chat.
      let targetSession = chats.find((c) => c.id === currentChatId) ?? null;
      if (!targetSession) {
        const id = newChatId();
        const now = Date.now();
        targetSession = {
          id,
          title: "New chat",
          created_at: now,
          updated_at: now,
          pinned: false,
          messages: [],
        };
      }

      const userMsg: StoredChatMessage = {
        role: "user",
        content: text,
        time: Date.now(),
      };
      const baseMessages = [...targetSession.messages, userMsg];
      await streamReply(targetSession, baseMessages);
    },
    [server, chats, currentChatId, streamReply],
  );

  const cancelChat = useCallback(() => {
    if (chatAbortRef.current) {
      log.info("chat", "cancel requested");
      chatAbortRef.current.abort();
    }
  }, []);

  const editMessage = useCallback(
    (chatId: string, index: number, content: string) => {
      setChats((prev) => {
        const next = prev.map((c) => {
          if (c.id !== chatId) return c;
          if (index < 0 || index >= c.messages.length) return c;
          const newMessages = c.messages.slice();
          newMessages[index] = { ...newMessages[index], content };
          return { ...c, messages: newMessages, updated_at: Date.now() };
        });
        persistChats(next);
        return next;
      });
      log.info("chat", `edit message #${index}`, { chatId });
    },
    [persistChats],
  );

  const deleteMessage = useCallback(
    (chatId: string, index: number) => {
      setChats((prev) => {
        const next = prev.map((c) => {
          if (c.id !== chatId) return c;
          if (index < 0 || index >= c.messages.length) return c;
          const newMessages = c.messages.slice();
          newMessages.splice(index, 1);
          return { ...c, messages: newMessages, updated_at: Date.now() };
        });
        persistChats(next);
        return next;
      });
      log.info("chat", `delete message #${index}`, { chatId });
    },
    [persistChats],
  );

  const resendFromMessage = useCallback(
    async (chatId: string, index: number) => {
      const session = chats.find((c) => c.id === chatId);
      if (!session) return;
      const msg = session.messages[index];
      if (!msg || msg.role !== "user") {
        log.warn("chat", "resend ignored: target is not a user message");
        return;
      }
      // Truncate to and including the user message; that becomes the new
      // tail of the conversation. Then stream a fresh assistant reply.
      const truncated = session.messages.slice(0, index + 1);
      log.info("chat", `resend from #${index} (truncating to ${truncated.length} msgs)`, {
        chatId,
      });
      await streamReply(session, truncated);
    },
    [chats, streamReply],
  );

  // expose old `clearChat` name as "discard current session" so callers don't break
  void fromView; // ensure helper kept (avoids unused-import warning)

  const value: AppState = useMemo(
    () => ({
      settings,
      build,
      scanning,
      scanError,
      pickBuildDir,
      setBuildDir,
      rescan,
      clearRecent,
      server,
      startError,
      startServer,
      stopServer,
      flags,
      setFlag,
      resetFlags,
      pickModel,
      agency,
      setAgency,
      models,
      modelsScanning,
      modelsScanError,
      modelInfo,
      modelInfoError,
      pickModelsDir,
      setModelsDir,
      rescanModels,
      clearModelsRecent,
      loadModelPath,
      saveProfile,
      loadProfile,
      deleteProfile,
      hw,
      hwSeries,
      chats,
      currentChatId,
      currentChat,
      chatMessages,
      chatPending,
      chatError,
      sendChat,
      cancelChat,
      newChat,
      selectChat,
      deleteChat,
      togglePinChat,
      renameChat,
      editMessage,
      deleteMessage,
      resendFromMessage,
      reasoningEnabled,
      setReasoningEnabled,
    }),
    [
      settings,
      build,
      scanning,
      scanError,
      pickBuildDir,
      setBuildDir,
      rescan,
      clearRecent,
      server,
      startError,
      startServer,
      stopServer,
      flags,
      setFlag,
      resetFlags,
      pickModel,
      agency,
      models,
      modelsScanning,
      modelsScanError,
      modelInfo,
      modelInfoError,
      pickModelsDir,
      setModelsDir,
      rescanModels,
      clearModelsRecent,
      loadModelPath,
      saveProfile,
      loadProfile,
      deleteProfile,
      hw,
      hwSeries,
      chats,
      currentChatId,
      currentChat,
      chatMessages,
      chatPending,
      chatError,
      sendChat,
      cancelChat,
      newChat,
      selectChat,
      deleteChat,
      togglePinChat,
      renameChat,
      editMessage,
      deleteMessage,
      resendFromMessage,
      reasoningEnabled,
      setReasoningEnabled,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppState(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAppState must be used inside AppStateProvider");
  return v;
}
