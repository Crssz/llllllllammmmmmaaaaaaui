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
  defaultSessionConfig,
  type BuildInfo,
  type ChatPreset,
  type ChatSession,
  type ChatSessionConfig,
  type GgufInfo,
  type HwSnapshot,
  type McpServerConfig,
  type McpStatus,
  type McpTool,
  type ModelsScan,
  type RunningInfo,
  type SavedProfile,
  type Settings,
  type StoredChatMessage,
  type ToolCall,
  type ToolPermission,
} from "./lib/api";
import { log, logFailure } from "./lib/logger";

type FlagValues = Record<string, string | number | boolean>;

export type ChatMessage = {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  time: number;
  reasoning?: string;
  meta?: { tps?: number; tokens?: number };
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  tool_name?: string;
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
    tool_calls: m.tool_calls ?? undefined,
    tool_call_id: m.tool_call_id ?? undefined,
    tool_name: m.tool_name ?? undefined,
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
    tool_calls: m.tool_calls ?? null,
    tool_call_id: m.tool_call_id ?? null,
    tool_name: m.tool_name ?? null,
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

/**
 * Flatten an MCP tools/call result into a single string suitable as the
 * content of a `tool` role message. MCP returns a structured response:
 *
 *   { content: [{ type: "text", text: "..." }, ...], isError?: boolean }
 *
 * We concatenate text parts, fall back to JSON-stringify for non-text parts,
 * and prefix with [error] when isError is set so the model sees the failure.
 */
export function mcpResultToText(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  const obj = raw as { content?: unknown; isError?: boolean };
  const parts: string[] = [];
  if (Array.isArray(obj.content)) {
    for (const p of obj.content) {
      if (p && typeof p === "object") {
        const pp = p as { type?: string; text?: string };
        if (pp.type === "text" && typeof pp.text === "string") {
          parts.push(pp.text);
          continue;
        }
      }
      try {
        parts.push(JSON.stringify(p));
      } catch {
        parts.push(String(p));
      }
    }
  } else {
    try {
      parts.push(JSON.stringify(raw));
    } catch {
      parts.push(String(raw));
    }
  }
  const text = parts.join("\n").trim();
  return obj.isError ? `[error] ${text}` : text;
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

  // per-session config + presets
  updateSessionConfig: (chatId: string, patch: Partial<ChatSessionConfig>) => void;
  applyPresetToSession: (chatId: string, presetId: string) => void;
  saveSessionAsPreset: (chatId: string, name: string) => Promise<void>;
  updatePreset: (id: string, patch: Partial<ChatPreset>) => Promise<void>;
  deletePreset: (id: string) => Promise<void>;

  // MCP
  mcpServers: McpServerConfig[];
  mcpStatuses: Record<string, McpStatus>;
  mcpTools: Record<string, McpTool[]>;
  mcpUpsertServer: (cfg: McpServerConfig) => Promise<void>;
  mcpDeleteServer: (id: string) => Promise<void>;
  mcpConnect: (id: string) => Promise<void>;
  mcpDisconnect: (id: string) => Promise<void>;
  mcpRefreshStatus: () => Promise<void>;

  // Tool approval flow ("ask" policy)
  pendingToolApproval: PendingToolApproval | null;
  approveTool: (id: string, decision: "allow" | "deny", remember?: boolean) => void;
};

export type PendingToolApproval = {
  /** Internal unique id so callbacks can target the right pending request. */
  id: string;
  serverId: string;
  serverName: string;
  toolName: string;
  args: Record<string, unknown>;
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
  mcp_servers: [],
  chat_presets: [],
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

  const [mcpStatuses, setMcpStatuses] = useState<Record<string, McpStatus>>({});
  const [mcpTools, setMcpTools] = useState<Record<string, McpTool[]>>({});
  const [pendingToolApproval, setPendingToolApproval] = useState<PendingToolApproval | null>(null);
  // Resolve callback for the current pending approval — set when we surface a
  // request to the user, called when they click Allow / Deny.
  const approvalResolveRef = useRef<((d: "allow" | "deny") => void) | null>(null);

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
      toolCalls: ToolCall[] | null,
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
            tool_calls: toolCalls && toolCalls.length > 0 ? toolCalls : null,
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

  // Append a fully-formed tool-role message (response to a single tool_call)
  // and persist. Returns the updated session for chaining the next round.
  const appendToolMessage = useCallback(
    (chatId: string, msg: StoredChatMessage) => {
      let updated: ChatSession | null = null;
      setChats((prev) => {
        const next = prev.map((c) => {
          if (c.id !== chatId) return c;
          const out = {
            ...c,
            messages: [...c.messages, msg],
            updated_at: Date.now(),
          };
          updated = out;
          return out;
        });
        persistChats(next);
        return next;
      });
      return updated;
    },
    [persistChats],
  );

  // Request user approval for a tool call when the policy is "ask". Resolves
  // once they click Allow / Deny in the chat UI. There's one outstanding
  // approval at a time (matches the one-stream-at-a-time chat model).
  const requestApproval = useCallback((req: PendingToolApproval) => {
    return new Promise<"allow" | "deny">((resolve) => {
      approvalResolveRef.current = resolve;
      setPendingToolApproval(req);
    });
  }, []);

  const approveTool = useCallback(
    (id: string, decision: "allow" | "deny", remember?: boolean) => {
      const cb = approvalResolveRef.current;
      const req = pendingToolApproval;
      approvalResolveRef.current = null;
      setPendingToolApproval(null);
      if (remember && req && currentChatId) {
        // Persist the decision as a per-tool override on the session config.
        const key = `${req.serverId}:${req.toolName}`;
        setChats((prev) => {
          const next = prev.map((c) => {
            if (c.id !== currentChatId) return c;
            const cfg = c.config ?? defaultSessionConfig();
            const per_tool = { ...cfg.tool_permissions.per_tool, [key]: decision };
            return {
              ...c,
              config: {
                ...cfg,
                tool_permissions: { ...cfg.tool_permissions, per_tool },
              },
              updated_at: Date.now(),
            };
          });
          persistChats(next);
          return next;
        });
      }
      void id;
      cb?.(decision);
    },
    [pendingToolApproval, currentChatId, persistChats],
  );

  // Run a single OpenAI-compatible streaming round. Returns the captured
  // results so the outer loop can decide whether to dispatch tool calls and
  // run another round. Throws on hard transport errors.
  const runChatRound = useCallback(
    async (
      chatId: string,
      messages: StoredChatMessage[],
      tools: Array<{
        type: "function";
        function: { name: string; description?: string; parameters: unknown };
      }>,
      chatTemplate?: string | null,
    ): Promise<{
      content: string;
      reasoning: string | null;
      toolCalls: ToolCall[];
      tokens: number | null;
      tps: number | null;
      error: string | null;
    }> => {
      if (!server.running || !server.info) throw new Error("server not running");
      const url = `http://127.0.0.1:${server.info.port}/v1/chat/completions`;
      const t0 = performance.now();
      const abort = new AbortController();
      chatAbortRef.current = abort;

      let rawContent = "";
      let streamedReasoning = "";
      let usageTokens: number | null = null;
      let streamError: string | null = null;
      const toolCallBuf: Map<number, ToolCall> = new Map();

      const useTemplateKwargs = flags.jinja === true;
      const apiMessages: Array<Record<string, unknown>> = messages.map((m) => {
        const out: Record<string, unknown> = { role: m.role, content: m.content };
        if (m.tool_calls && m.tool_calls.length > 0) out.tool_calls = m.tool_calls;
        if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
        if (m.tool_name) out.name = m.tool_name;
        return out;
      });
      const body: Record<string, unknown> = {
        model: "local",
        stream: true,
        stream_options: { include_usage: true },
        messages: apiMessages,
      };
      if (tools.length > 0) body.tools = tools;
      if (useTemplateKwargs) {
        body.chat_template_kwargs = { enable_thinking: reasoningEnabled };
      }
      if (chatTemplate && chatTemplate.trim()) {
        // llama-server accepts chat_template in the request body (b4400+).
        // When absent the server falls back to the model-default template.
        body.chat_template = chatTemplate;
      }

      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: abort.signal,
        });
        if (!res.ok) {
          const errBody = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status}${errBody ? `: ${errBody}` : ""}`);
        }
        if (!res.body) throw new Error("response has no body");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
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
            if (payload === "[DONE]") continue;
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
              let touched = false;
              if (typeof delta.content === "string" && delta.content.length > 0) {
                rawContent += delta.content;
                touched = true;
              }
              if (
                typeof delta.reasoning_content === "string" &&
                delta.reasoning_content.length > 0
              ) {
                streamedReasoning += delta.reasoning_content;
                touched = true;
              }
              const tcDeltas = delta.tool_calls;
              if (Array.isArray(tcDeltas)) {
                for (const tc of tcDeltas) {
                  const idx = typeof tc.index === "number" ? tc.index : 0;
                  const slot =
                    toolCallBuf.get(idx) ??
                    ({
                      id: tc.id || `call_${idx}_${Date.now()}`,
                      type: "function" as const,
                      function: { name: "", arguments: "" },
                    } as ToolCall);
                  if (tc.id) slot.id = tc.id;
                  if (tc.function?.name) slot.function.name = tc.function.name;
                  if (typeof tc.function?.arguments === "string") {
                    slot.function.arguments += tc.function.arguments;
                  }
                  toolCallBuf.set(idx, slot);
                  touched = true;
                }
              }
              if (touched) {
                const now = performance.now();
                if (now >= nextFlush) {
                  const split = splitThink(rawContent);
                  const reasoning = (
                    streamedReasoning + (split.reasoning ? "\n" + split.reasoning : "")
                  ).trim();
                  patchAssistantContent(chatId, split.content, reasoning || null);
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
      } catch (e: unknown) {
        if ((e as { name?: string })?.name === "AbortError") {
          log.info("chat", "request aborted by user");
          streamError = "aborted";
        } else {
          const msg = e instanceof Error ? e.message : String(e);
          streamError = msg;
          log.error("chat", "request failed", { error: msg, url });
        }
      } finally {
        chatAbortRef.current = null;
      }

      const elapsed = (performance.now() - t0) / 1000;
      const tps = usageTokens && elapsed > 0 ? usageTokens / elapsed : null;
      const split = splitThink(rawContent);
      const reasoning =
        (streamedReasoning + (split.reasoning ? "\n" + split.reasoning : "")).trim() || null;
      const toolCalls = Array.from(toolCallBuf.values()).filter((tc) => tc.function.name);
      log.info(
        "chat",
        `← ${usageTokens ?? "?"} tokens in ${elapsed.toFixed(2)}s, ${toolCalls.length} tool_calls`,
      );
      return {
        content: split.content,
        reasoning,
        toolCalls,
        tokens: usageTokens,
        tps,
        error: streamError,
      };
    },
    [server, flags.jinja, reasoningEnabled, patchAssistantContent],
  );

  // Outer streaming helper: handles system prompt, MCP tool injection, and
  // looping when the model emits tool calls. `baseMessages` is the conversation
  // history (already including the new user message, if any).
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

      // Compose the effective message list: prepend a system message if the
      // session config sets one. Otherwise pass through.
      const cfg = session.config ?? null;
      const composedMessages: StoredChatMessage[] = [];
      if (cfg?.system_prompt && cfg.system_prompt.trim()) {
        composedMessages.push({
          role: "system",
          content: cfg.system_prompt.trim(),
          time: Date.now(),
        });
      }
      composedMessages.push(...baseMessages);

      // Build the tools list from currently-connected, session-enabled MCP
      // servers. We skip servers that aren't connected — the user must
      // explicitly connect them on the MCP screen first.
      const enabledIds = cfg?.mcp_server_ids ?? [];
      const tools: Array<{
        type: "function";
        function: { name: string; description?: string; parameters: unknown };
      }> = [];
      const toolIndex: Map<string, { serverId: string; toolName: string }> = new Map();
      for (const sid of enabledIds) {
        const status = mcpStatuses[sid];
        if (!status?.connected) continue;
        const toolList = mcpTools[sid] ?? [];
        for (const t of toolList) {
          // Prefix tool names with the server id to disambiguate when two
          // servers expose the same tool name.
          const exposed = `${sid}__${t.name}`;
          tools.push({
            type: "function",
            function: {
              name: exposed,
              description: t.description ?? undefined,
              parameters: t.input_schema,
            },
          });
          toolIndex.set(exposed, { serverId: sid, toolName: t.name });
        }
      }

      // Add the assistant placeholder up front so the UI streams into it.
      const placeholder: StoredChatMessage = { role: "assistant", content: "", time: Date.now() };
      let working: ChatSession = {
        ...session,
        title: session.messages.length === 0 ? deriveTitle(baseMessages) : session.title,
        updated_at: Date.now(),
        messages: [...baseMessages, placeholder],
      };
      setChats((prev) => {
        const others = prev.filter((c) => c.id !== working.id);
        const next = [working, ...others];
        persistChats(next);
        return next;
      });
      setCurrentChatId(working.id);
      setChatPending(true);

      // We pass the composed list (system prefix + history + placeholder).
      // The placeholder content is empty so it doesn't pollute the request.
      let liveMessages: StoredChatMessage[] = [...composedMessages];

      try {
        // Loop up to a sane bound to avoid runaway tool-call cycles.
        for (let round = 0; round < 8; round++) {
          const result = await runChatRound(
            working.id,
            liveMessages,
            tools,
            cfg?.chat_template ?? null,
          );
          if (result.error === "aborted") {
            finalizeAssistant(
              working.id,
              result.content,
              result.reasoning,
              result.tokens,
              result.tps,
              result.toolCalls.length > 0 ? result.toolCalls : null,
            );
            break;
          }
          if (
            result.error &&
            !result.content &&
            !result.reasoning &&
            result.toolCalls.length === 0
          ) {
            finalizeAssistant(
              working.id,
              `⚠️ ${result.error}`,
              null,
              result.tokens,
              result.tps,
              null,
            );
            setChatError(result.error);
            break;
          }
          // Persist this round's assistant message.
          finalizeAssistant(
            working.id,
            result.content,
            result.reasoning,
            result.tokens,
            result.tps,
            result.toolCalls.length > 0 ? result.toolCalls : null,
          );
          if (result.error) setChatError(result.error);

          if (result.toolCalls.length === 0) break;

          // Run each tool call (with permission gating) and append `tool`
          // role messages with the results. Then loop.
          const assistantMsg: StoredChatMessage = {
            role: "assistant",
            content: result.content,
            time: Date.now(),
            reasoning: result.reasoning,
            tool_calls: result.toolCalls,
          };
          liveMessages = [...liveMessages, assistantMsg];

          for (const tc of result.toolCalls) {
            const mapped = toolIndex.get(tc.function.name);
            if (!mapped) {
              const errMsg: StoredChatMessage = {
                role: "tool",
                content: `Tool ${tc.function.name} is not registered for this session.`,
                time: Date.now(),
                tool_call_id: tc.id,
                tool_name: tc.function.name,
              };
              appendToolMessage(working.id, errMsg);
              liveMessages.push(errMsg);
              continue;
            }
            const sid = mapped.serverId;
            const toolName = mapped.toolName;
            const serverCfg = settings.mcp_servers.find((s) => s.id === sid);
            const serverName = serverCfg?.name ?? sid;

            // Permission check
            const perms = cfg?.tool_permissions ?? {
              default: "ask" as ToolPermission,
              per_tool: {},
            };
            const policy: ToolPermission = perms.per_tool[`${sid}:${toolName}`] ?? perms.default;

            let args: Record<string, unknown> = {};
            try {
              args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
            } catch {
              args = { _raw: tc.function.arguments };
            }

            let decision: "allow" | "deny" = "allow";
            if (policy === "deny") {
              decision = "deny";
            } else if (policy === "ask") {
              const reqId = `${tc.id}_${Date.now()}`;
              decision = await requestApproval({
                id: reqId,
                serverId: sid,
                serverName,
                toolName,
                args,
              });
            }

            if (decision === "deny") {
              const denyMsg: StoredChatMessage = {
                role: "tool",
                content: `Tool call denied by user policy.`,
                time: Date.now(),
                tool_call_id: tc.id,
                tool_name: toolName,
              };
              appendToolMessage(working.id, denyMsg);
              liveMessages.push(denyMsg);
              continue;
            }

            try {
              log.info("mcp", `call ${sid}/${toolName}`, { args });
              const raw = await api.mcpCallTool(sid, toolName, args);
              const text = mcpResultToText(raw);
              const okMsg: StoredChatMessage = {
                role: "tool",
                content: text,
                time: Date.now(),
                tool_call_id: tc.id,
                tool_name: toolName,
              };
              appendToolMessage(working.id, okMsg);
              liveMessages.push(okMsg);
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              log.error("mcp", `tool call failed`, { server: sid, tool: toolName, error: msg });
              const errMsg: StoredChatMessage = {
                role: "tool",
                content: `Tool execution failed: ${msg}`,
                time: Date.now(),
                tool_call_id: tc.id,
                tool_name: toolName,
              };
              appendToolMessage(working.id, errMsg);
              liveMessages.push(errMsg);
            }
          }

          // Prepare a new placeholder for the next round.
          const nextPlaceholder: StoredChatMessage = {
            role: "assistant",
            content: "",
            time: Date.now(),
          };
          setChats((prev) => {
            const next = prev.map((c) => {
              if (c.id !== working.id) return c;
              const out = {
                ...c,
                messages: [...c.messages, nextPlaceholder],
                updated_at: Date.now(),
              };
              working = out;
              return out;
            });
            persistChats(next);
            return next;
          });
        }
      } finally {
        setChatPending(false);
      }
    },
    [
      server,
      persistChats,
      runChatRound,
      finalizeAssistant,
      appendToolMessage,
      mcpStatuses,
      mcpTools,
      settings.mcp_servers,
      requestApproval,
    ],
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

  // ── Per-session config + presets ─────────────────────────────────────────
  const updateSessionConfig = useCallback(
    (chatId: string, patch: Partial<ChatSessionConfig>) => {
      setChats((prev) => {
        const next = prev.map((c) => {
          if (c.id !== chatId) return c;
          const cur = c.config ?? defaultSessionConfig();
          return { ...c, config: { ...cur, ...patch }, updated_at: Date.now() };
        });
        persistChats(next);
        return next;
      });
    },
    [persistChats],
  );

  const applyPresetToSession = useCallback(
    (chatId: string, presetId: string) => {
      const preset = settings.chat_presets.find((p) => p.id === presetId);
      if (!preset) return;
      setChats((prev) => {
        const next = prev.map((c) => {
          if (c.id !== chatId) return c;
          return {
            ...c,
            config: { ...preset.config, preset_id: preset.id },
            updated_at: Date.now(),
          };
        });
        persistChats(next);
        return next;
      });
    },
    [persistChats, settings.chat_presets],
  );

  const saveSessionAsPreset = useCallback(
    async (chatId: string, name: string) => {
      const session = chats.find((c) => c.id === chatId);
      if (!session) return;
      const config: ChatSessionConfig = session.config ?? defaultSessionConfig();
      const preset: ChatPreset = {
        id: `preset_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        name: name || "Untitled preset",
        created_at: Date.now(),
        config: { ...config, preset_id: null },
      };
      const updated: Settings = {
        ...settings,
        chat_presets: [preset, ...settings.chat_presets].slice(0, 50),
      };
      await api.saveSettings(updated);
      setSettings(updated);
      // Mark the session as linked to the new preset.
      updateSessionConfig(chatId, { preset_id: preset.id });
    },
    [chats, settings, updateSessionConfig],
  );

  const updatePreset = useCallback(
    async (id: string, patch: Partial<ChatPreset>) => {
      const updated: Settings = {
        ...settings,
        chat_presets: settings.chat_presets.map((p) => (p.id === id ? { ...p, ...patch } : p)),
      };
      await api.saveSettings(updated);
      setSettings(updated);
    },
    [settings],
  );

  const deletePreset = useCallback(
    async (id: string) => {
      const updated: Settings = {
        ...settings,
        chat_presets: settings.chat_presets.filter((p) => p.id !== id),
      };
      await api.saveSettings(updated);
      setSettings(updated);
    },
    [settings],
  );

  // ── MCP CRUD + connection management ─────────────────────────────────────
  const refreshMcpStatus = useCallback(async () => {
    try {
      const statuses = await api.mcpStatusAll();
      const byId: Record<string, McpStatus> = {};
      for (const s of statuses) byId[s.id] = s;
      setMcpStatuses(byId);
      // For each connected server we don't yet have tools for, fetch them.
      for (const s of statuses) {
        if (s.connected && !mcpTools[s.id]) {
          try {
            const tools = await api.mcpListTools(s.id);
            setMcpTools((cur) => ({ ...cur, [s.id]: tools }));
          } catch (e) {
            log.warn("mcp", `list_tools failed`, { id: s.id, error: String(e) });
          }
        }
      }
    } catch (e) {
      log.warn("mcp", "status_all failed", { error: String(e) });
    }
  }, [mcpTools]);

  const mcpUpsertServer = useCallback(
    async (cfg: McpServerConfig) => {
      const exists = settings.mcp_servers.some((s) => s.id === cfg.id);
      const mcp_servers = exists
        ? settings.mcp_servers.map((s) => (s.id === cfg.id ? cfg : s))
        : [...settings.mcp_servers, cfg];
      const updated: Settings = { ...settings, mcp_servers };
      await api.saveSettings(updated);
      setSettings(updated);
    },
    [settings],
  );

  const mcpDeleteServer = useCallback(
    async (id: string) => {
      try {
        await api.mcpDisconnect(id);
      } catch {
        /* ignore — may not be connected */
      }
      const updated: Settings = {
        ...settings,
        mcp_servers: settings.mcp_servers.filter((s) => s.id !== id),
      };
      await api.saveSettings(updated);
      setSettings(updated);
      setMcpStatuses((cur) => {
        const next = { ...cur };
        delete next[id];
        return next;
      });
      setMcpTools((cur) => {
        const next = { ...cur };
        delete next[id];
        return next;
      });
    },
    [settings],
  );

  const mcpConnectCmd = useCallback(async (id: string) => {
    try {
      const status = await api.mcpConnect(id);
      setMcpStatuses((cur) => ({ ...cur, [id]: status }));
      try {
        const tools = await api.mcpListTools(id);
        setMcpTools((cur) => ({ ...cur, [id]: tools }));
      } catch (e) {
        log.warn("mcp", `list_tools after connect failed`, { id, error: String(e) });
      }
      log.info("mcp", `connected ${id}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error("mcp", `connect failed`, { id, error: msg });
      setMcpStatuses((cur) => ({
        ...cur,
        [id]: { id, connected: false, error: msg, tool_count: 0, server_name: null },
      }));
      throw e;
    }
  }, []);

  const mcpDisconnectCmd = useCallback(async (id: string) => {
    await api.mcpDisconnect(id);
    setMcpStatuses((cur) => ({
      ...cur,
      [id]: { id, connected: false, error: null, tool_count: 0, server_name: null },
    }));
    setMcpTools((cur) => {
      const next = { ...cur };
      delete next[id];
      return next;
    });
  }, []);

  // Autostart any MCP servers flagged for autostart, once on mount after
  // settings have loaded.
  const autostartedRef = useRef(false);
  useEffect(() => {
    if (autostartedRef.current) return;
    if (!settings.mcp_servers || settings.mcp_servers.length === 0) return;
    autostartedRef.current = true;
    (async () => {
      await refreshMcpStatus();
      for (const s of settings.mcp_servers) {
        if (s.autostart) {
          mcpConnectCmd(s.id).catch(() => {});
        }
      }
    })();
  }, [settings.mcp_servers, refreshMcpStatus, mcpConnectCmd]);

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
      updateSessionConfig,
      applyPresetToSession,
      saveSessionAsPreset,
      updatePreset,
      deletePreset,
      mcpServers: settings.mcp_servers,
      mcpStatuses,
      mcpTools,
      mcpUpsertServer,
      mcpDeleteServer,
      mcpConnect: mcpConnectCmd,
      mcpDisconnect: mcpDisconnectCmd,
      mcpRefreshStatus: refreshMcpStatus,
      pendingToolApproval,
      approveTool,
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
      updateSessionConfig,
      applyPresetToSession,
      saveSessionAsPreset,
      updatePreset,
      deletePreset,
      mcpStatuses,
      mcpTools,
      mcpUpsertServer,
      mcpDeleteServer,
      mcpConnectCmd,
      mcpDisconnectCmd,
      refreshMcpStatus,
      pendingToolApproval,
      approveTool,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppState(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAppState must be used inside AppStateProvider");
  return v;
}
