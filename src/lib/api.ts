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
  role: "user" | "assistant" | "system";
  content: string;
  time: number;
  tps?: number | null;
  tokens?: number | null;
  reasoning?: string | null;
};

export type ChatSession = {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  pinned: boolean;
  messages: StoredChatMessage[];
};

export type SavedProfile = {
  id: string;
  name: string;
  created_at: number;
  flags: Record<string, unknown>;
  model_path: string | null;
  agency: string | null;
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
