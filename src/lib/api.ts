import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export type DetectedBinary = {
  name: string;
  path: string;
  size: string;
  ok: boolean;
  primary: boolean;
  desc: string;
};

export type BuildInfo = {
  path: string;
  resolved_path: string;
  detected: boolean;
  version: string | null;
  commit: string | null;
  backend_badges: string[];
  binaries: DetectedBinary[];
};

export type StoredChatMessage = {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  time: number;
  tps?: number | null;
  tokens?: number | null;
  reasoning?: string | null;
  /** Set on assistant messages that emitted tool calls. */
  tool_calls?: ToolCall[] | null;
  /** Set on `tool` role messages — id of the tool_call this responds to. */
  tool_call_id?: string | null;
  /** Set on `tool` role messages — display name of the tool. */
  tool_name?: string | null;
};

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ToolPermission = "allow" | "ask" | "deny";

export type ToolPermissions = {
  default: ToolPermission;
  per_tool: Record<string, ToolPermission>;
};

export type ChatSessionConfig = {
  system_prompt: string | null;
  chat_template: string | null;
  mcp_server_ids: string[];
  tool_permissions: ToolPermissions;
  preset_id: string | null;
};

export type ChatPreset = {
  id: string;
  name: string;
  created_at: number;
  config: ChatSessionConfig;
};

export type ChatSession = {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  pinned: boolean;
  messages: StoredChatMessage[];
  config?: ChatSessionConfig | null;
};

export type SavedProfile = {
  id: string;
  name: string;
  created_at: number;
  flags: Record<string, unknown>;
  model_path: string | null;
  agency: string | null;
};

export type McpTransport = "stdio" | "http" | "sse";

export type McpServerConfig = {
  id: string;
  name: string;
  transport: McpTransport;
  command?: string | null;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string | null;
  url?: string | null;
  headers?: Record<string, string>;
  enabled: boolean;
  autostart: boolean;
};

export type McpTool = {
  name: string;
  description: string | null;
  input_schema: Record<string, unknown>;
};

export type McpStatus = {
  id: string;
  connected: boolean;
  error: string | null;
  tool_count: number;
  server_name: string | null;
};

export type Settings = {
  build_dir: string | null;
  recent_dirs: string[];
  model_path: string | null;
  flags: Record<string, unknown>;
  models_dir: string | null;
  models_recent: string[];
  profiles: SavedProfile[];
  reasoning_enabled: boolean | null;
  mcp_servers: McpServerConfig[];
  chat_presets: ChatPreset[];
};

export type RunningInfo = {
  pid: number;
  port: number;
  started_at: number;
  binary: string;
};

export type ServerStatus = {
  running: boolean;
  ready: boolean;
  info: RunningInfo | null;
};

export type QuantFile = {
  tag: string;
  filename: string;
  path: string;
  size_gb: number;
  bits: number;
  badges: string[];
};

export type ModelEntry = {
  name: string;
  params: string | null;
  family: string | null;
  mtp: boolean;
  draft: boolean;
  quants: QuantFile[];
  mmproj_files: string[];
};

export type OwnerEntry = {
  owner: string;
  models: ModelEntry[];
};

export type ModelsScan = {
  path: string;
  total_gb: number;
  count: number;
  owners: number;
  tree: OwnerEntry[];
};

export type GgufInfo = {
  path: string;
  gguf_version: number;
  tensor_count: number;
  metadata_count: number;
  architecture: string | null;
  general_name: string | null;
  context_length: number | null;
  mtp_support: boolean;
  size_gb: number;
  mmproj_siblings: string[];
};

export type GpuInfo = {
  name: string;
  vram_total_gb: number;
  vram_used_gb: number;
  // null means the active backend doesn't expose this field (e.g. HIP runtime
  // gives us VRAM but not util/temp/power/clocks).
  util: number | null;
  temp_c: number | null;
  power_w: number | null;
  clock_mhz: number | null;
};

export type HwSnapshot = {
  cpu_util: number;
  cpu_name: string;
  cpu_cores: number;
  cpu_freq_ghz: number;
  ram_total_gb: number;
  ram_used_gb: number;
  swap_used_gb: number;
  gpus: GpuInfo[];
  gpu_backend: string;
};

export function defaultSessionConfig(): ChatSessionConfig {
  return {
    system_prompt: null,
    chat_template: null,
    mcp_server_ids: [],
    tool_permissions: { default: "ask", per_tool: {} },
    preset_id: null,
  };
}

export const api = {
  loadSettings: () => invoke<Settings>("load_settings"),
  saveSettings: (settings: Settings) => invoke<void>("save_settings", { settings }),
  addRecentDir: (dir: string) => invoke<Settings>("add_recent_dir", { dir }),
  addRecentModelsDir: (dir: string) => invoke<Settings>("add_recent_models_dir", { dir }),

  scanBuild: (dir: string) => invoke<BuildInfo>("scan_build", { dir }),
  scanModels: (dir: string) => invoke<ModelsScan>("scan_models", { dir }),
  inspectGguf: (path: string) => invoke<GgufInfo>("inspect_gguf", { path }),
  hwSnapshot: () => invoke<HwSnapshot>("hw_snapshot"),

  startServer: (buildDir: string, args: string[]) =>
    invoke<RunningInfo>("start_server", { buildDir, args }),
  stopServer: () => invoke<void>("stop_server"),
  serverStatus: () => invoke<ServerStatus>("server_status"),

  loadChats: () => invoke<ChatSession[]>("load_chats"),
  saveChats: (chats: ChatSession[]) => invoke<void>("save_chats", { chats }),

  mcpConnect: (id: string) => invoke<McpStatus>("mcp_connect", { id }),
  mcpDisconnect: (id: string) => invoke<void>("mcp_disconnect", { id }),
  mcpListTools: (id: string) => invoke<McpTool[]>("mcp_list_tools", { id }),
  mcpCallTool: (id: string, name: string, args: Record<string, unknown>) =>
    invoke<unknown>("mcp_call_tool", { id, name, arguments: args }),
  mcpStatusAll: () => invoke<McpStatus[]>("mcp_status_all"),

  pickFolder: (title = "Select a directory") =>
    open({ directory: true, multiple: false, title }) as Promise<string | null>,
  pickFile: (title = "Select GGUF model file", extensions = ["gguf"]) =>
    open({
      directory: false,
      multiple: false,
      title,
      filters: [{ name: "GGUF model", extensions }],
    }) as Promise<string | null>,
};
