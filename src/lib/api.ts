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

/** One downloadable Windows asset of a llama.cpp release (mirrors Rust `EngineAsset`). */
export type EngineAsset = {
  name: string;
  url: string;
  size: number;
  /** "vulkan" | "cpu" | "cuda" | "hip" | "hip-gfxNNNN" | "other". */
  variant: string;
  os: string;
  arch: string;
  /** Stable install id: `<tag>-<variant>-<arch>`. */
  id: string;
};

/** A llama.cpp release with its Windows engine assets (mirrors Rust `EngineRelease`). */
export type EngineRelease = {
  tag: string;
  name: string;
  published_at: string;
  assets: EngineAsset[];
};

/** An engine already downloaded into the library (mirrors Rust `InstalledEngine`). */
export type InstalledEngine = {
  id: string;
  path: string;
  tag: string | null;
  variant: string | null;
  arch: string | null;
  version: string | null;
  commit: string | null;
  backend_badges: string[];
  size: string;
  installed_at: number | null;
  active: boolean;
};

/** `engine-progress` event payload (mirrors Rust `EngineProgress`). */
export type EngineProgress = {
  generation: number;
  id: string;
  tag: string;
  phase: "download" | "extract" | "scan";
  downloaded: number;
  total: number;
};

/** `engine-done` event payload (mirrors Rust `EngineDone`). */
export type EngineDone = {
  generation: number;
  id: string;
  tag: string;
  ok: boolean;
  cancelled: boolean;
  error: string | null;
  installed: InstalledEngine | null;
};

// ── Model catalog (HuggingFace GGUF) — mirror Rust catalog.rs ───────────────

/** One model in the catalog search results (mirrors Rust `CatalogModel`). */
export type CatalogModel = {
  /** Full repo id, "owner/name". */
  id: string;
  owner: string;
  name: string;
  downloads: number;
  likes: number;
  /** True when the repo requires accepting terms / a token to download. */
  gated: boolean;
  /** "auto" | "manual" when gated, else null. */
  gated_kind: string | null;
  pipeline_tag: string | null;
  library_name: string | null;
  last_modified: string | null;
  tags: string[];
  /** Number of *.gguf siblings (quick indicator before the tree is fetched). */
  gguf_count: number;
  params: string | null;
};

/** One downloadable quant in a repo (a single file or a split group). */
export type CatalogFile = {
  filename: string;
  tag: string;
  bits: number;
  /** Total bytes across all parts. */
  size: number;
  size_gb: number;
  badges: string[];
  is_split: boolean;
  n_parts: number;
  /** Repo-relative paths of every part, ordered. */
  url_paths: string[];
  is_mmproj: boolean;
};

/** `catalog-progress` event payload (mirrors Rust `CatalogProgress`). */
export type CatalogProgress = {
  generation: number;
  repo_id: string;
  filename: string;
  downloaded: number;
  total: number;
  part: number;
  parts: number;
};

/** `catalog-done` event payload (mirrors Rust `CatalogDone`). */
export type CatalogDone = {
  generation: number;
  repo_id: string;
  filename: string;
  ok: boolean;
  cancelled: boolean;
  error: string | null;
  dest_root: string | null;
  model_path: string | null;
};

/** Audio clip attached to a chat message (mirrors Rust `AudioAttachment`). */
export type AudioAttachment = {
  /** Absolute path to a wav/mp3 file on disk. */
  path: string;
  /** `"wav"` or `"mp3"` — what llama-server's `input_audio.format` expects. */
  format: string;
  /** Capture/playback length in ms, when known. Pure UX hint. */
  duration_ms?: number | null;
};

/** Image attached to a chat message (mirrors Rust `ImageAttachment`). */
export type ImageAttachment = {
  /** Absolute path to an image file on disk. */
  path: string;
  /** Canonical extension: `jpeg` | `png` | `gif` | `webp`. */
  format: string;
  /** Pixel dimensions, when known. Pure UX hints. */
  width?: number | null;
  height?: number | null;
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
  /** Audio clip attached by the user (mic recording or picked file). */
  audio?: AudioAttachment | null;
  /** Image attached by the user (picked file) for a vision model. */
  image?: ImageAttachment | null;
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
  /** Absolute path of the project folder opened for this session. When set,
   *  the chat offers the built-in workspace file tools rooted here. Optional
   *  so configs persisted before this feature still type-check. */
  workspace_root?: string | null;
  preset_id: string | null;
};

export type ChatPreset = {
  id: string;
  name: string;
  created_at: number;
  config: ChatSessionConfig;
};

/** Groups multiple chats under a shared default config (system prompt,
 *  project folder, MCP servers, tool permissions). Membership is tracked on
 *  each ChatSession via `workspace_id`, independent of preset linkage. */
export type Workspace = {
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
  /** Workspace this chat belongs to. Undefined/null = no workspace (shows
   *  under "All chats", ungrouped). */
  workspace_id?: string | null;
  messages: StoredChatMessage[];
  config?: ChatSessionConfig | null;
};

export type SavedProfile = {
  id: string;
  name: string;
  created_at: number;
  flags: Record<string, unknown>;
  model_path: string | null;
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
  /** Per-model runtime config, keyed by absolute model path. Each model
   *  remembers its own flags (everything except the `model` path key, which is
   *  the map key); selecting a model auto-restores its saved config. */
  model_configs: Record<string, Record<string, unknown>>;
  /** Model paths whose `mmproj` projector the user set or cleared explicitly.
   *  For these, the loader leaves `mmproj` alone instead of auto-detecting a
   *  sibling projector from the model's folder. */
  mmproj_pinned: string[];
  models_dir: string | null;
  models_recent: string[];
  profiles: SavedProfile[];
  reasoning_enabled: boolean | null;
  mcp_servers: McpServerConfig[];
  chat_presets: ChatPreset[];
  /** Chat-grouping workspaces — see `Workspace`. */
  workspaces: Workspace[];
  /** Optional HuggingFace access token, sent as a Bearer token on catalog
   *  requests to lift rate-limiting, speed up downloads, and reach gated repos. */
  hf_token: string | null;
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

/** Base64-encoded audio clip for an `input_audio` content part. */
export type AudioPayload = {
  data: string;
  format: string;
};

/** Base64-encoded image for an `image_url` content part. */
export type ImagePayload = {
  data: string;
  format: string;
  /** `image/<format>` — ready to prefix a `data:` URL. */
  mime: string;
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
  /** True when the embedded chat template references `enable_thinking`. */
  supports_thinking: boolean;
  /** How reasoning is rendered: "channel" | "think_tags" | "other" | null. */
  thinking_style: string | null;
};

// ── Benchmark (mirror Rust bench.rs) ────────────────────────────────────────

/** One result row from `llama-bench -o json`. Field names match the JSON
 *  exactly: `avg_ts`/`stddev_ts` are tok/s, `flash_attn` is an int (0/1/2),
 *  cache types are `type_k`/`type_v`, and pp/tg is derived from n_prompt/n_gen. */
export type BenchRow = {
  model_filename: string;
  model_type: string;
  model_size: number;
  model_n_params: number;
  build_commit: string;
  test_time: string;
  n_prompt: number;
  n_gen: number;
  n_depth: number;
  n_gpu_layers: number;
  n_batch: number;
  n_ubatch: number;
  n_threads: number;
  flash_attn: number;
  type_k: string;
  type_v: string;
  avg_ns: number;
  stddev_ns: number;
  avg_ts: number;
  stddev_ts: number;
};

/** A persisted benchmark run (history entry). Built/labelled on the frontend. */
export type BenchRun = {
  id: string;
  created_at: number;
  model_path: string;
  label: string;
  rows: BenchRow[];
  note?: string | null;
};

/** Benchmark parameters. Each matrix field is a comma-joined string (e.g.
 *  "512,1024") that llama-bench expands into a benchmark matrix. */
export type BenchRequest = {
  model: string;
  n_prompt: string;
  n_gen: string;
  n_gpu_layers: string;
  threads: string;
  batch: string;
  ubatch: string;
  cache_type_k: string;
  cache_type_v: string;
  flash_attn: string;
  reps: number;
  extra?: string[];
};

/** Per-line stderr progress emitted while a benchmark runs. */
export type BenchProgressEvent = { generation: number; line: string };

/** Terminal event for a benchmark run (success, failure, or cancellation). */
export type BenchDoneEvent = {
  generation: number;
  ok: boolean;
  cancelled: boolean;
  error: string | null;
  rows: BenchRow[];
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
    workspace_root: null,
    preset_id: null,
  };
}

export function makeWorkspace(name: string): Workspace {
  return {
    id: `ws_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: name || "Untitled workspace",
    created_at: Date.now(),
    config: defaultSessionConfig(),
  };
}

// ── Workspace file tools (mirror Rust workspace.rs) ─────────────────────────

export type WsEntry = { name: string; is_dir: boolean; size: number };

export type WsRead = {
  path: string;
  total_lines: number;
  start_line: number;
  end_line: number;
  truncated: boolean;
  content: string;
};

export type WsWrite = { path: string; bytes: number; created: boolean };

export type WsEdit = { path: string; replacements: number };

export type WsMatch = { path: string; line: number; text: string };

export type WsSearch = { matches: WsMatch[]; truncated: boolean; files_scanned: number };

export type WsFind = { paths: string[]; truncated: boolean };

export const api = {
  loadSettings: () => invoke<Settings>("load_settings"),
  saveSettings: (settings: Settings) => invoke<void>("save_settings", { settings }),
  addRecentDir: (dir: string) => invoke<Settings>("add_recent_dir", { dir }),
  addRecentModelsDir: (dir: string) => invoke<Settings>("add_recent_models_dir", { dir }),

  scanBuild: (dir: string) => invoke<BuildInfo>("scan_build", { dir }),
  scanModels: (dir: string) => invoke<ModelsScan>("scan_models", { dir }),
  inspectGguf: (path: string) => invoke<GgufInfo>("inspect_gguf", { path }),
  // Delete a .gguf from disk (split models lose all sibling parts); resolves
  // with the number of files removed.
  deleteModelFile: (path: string) => invoke<number>("delete_model_file", { path }),
  hwSnapshot: () => invoke<HwSnapshot>("hw_snapshot"),

  // OS integrations via tauri-plugin-opener — the plugin is initialized on
  // the backend and `opener:default` grants both commands, but the npm
  // binding isn't installed, so invoke the plugin commands directly.
  revealInExplorer: (path: string) => invoke<void>("plugin:opener|reveal_item_in_dir", { path }),
  openUrl: (url: string) => invoke<void>("plugin:opener|open_url", { url }),

  startServer: (buildDir: string, args: string[]) =>
    invoke<RunningInfo>("start_server", { buildDir, args }),
  stopServer: () => invoke<void>("stop_server"),
  serverStatus: () => invoke<ServerStatus>("server_status"),

  // Persist a mic recording (a complete WAV byte stream) to the app cache dir
  // and get back its path, ready to read back as base64 like a picked file.
  // `name` is an optional filename — Transcribe omits it (single overwriting
  // `recording.wav`); Chat passes a unique name per clip.
  saveRecording: (bytes: Uint8Array, name?: string) =>
    invoke<string>("save_recording", { bytes: Array.from(bytes), name: name ?? null }),
  // Read a wav/mp3 file off disk and base64-encode it for an input_audio
  // request to llama-server's /v1/chat/completions.
  readAudioBase64: (path: string) => invoke<AudioPayload>("read_audio_base64", { path }),
  // Read an image file off disk and base64-encode it for an image_url request.
  readImageBase64: (path: string) => invoke<ImagePayload>("read_image_base64", { path }),

  loadChats: () => invoke<ChatSession[]>("load_chats"),
  saveChats: (chats: ChatSession[]) => invoke<void>("save_chats", { chats }),

  // Spawn llama-bench; resolves with the run's generation id. Progress arrives
  // via `bench-progress` events and results via a `bench-done` event.
  runBench: (buildDir: string, req: BenchRequest) => invoke<number>("run_bench", { buildDir, req }),
  cancelBench: () => invoke<void>("cancel_bench"),
  loadBenchRuns: () => invoke<BenchRun[]>("load_bench_runs"),
  saveBenchRuns: (runs: BenchRun[]) => invoke<void>("save_bench_runs", { runs }),

  // Engine manager. `listEngineReleases` hits the GitHub API (off the main
  // thread on the backend). `downloadEngine` resolves with the run's generation
  // id; progress arrives via `engine-progress` and the result via `engine-done`.
  listEngineReleases: (limit?: number) =>
    invoke<EngineRelease[]>("list_engine_releases", { limit: limit ?? null }),
  listInstalledEngines: () => invoke<InstalledEngine[]>("list_installed_engines"),
  downloadEngine: (asset: EngineAsset, tag: string) =>
    invoke<number>("download_engine", {
      tag,
      variant: asset.variant,
      arch: asset.arch,
      assetName: asset.name,
      assetUrl: asset.url,
      expectedSize: asset.size,
    }),
  cancelEngineDownload: () => invoke<void>("cancel_engine_download"),
  deleteEngine: (id: string) => invoke<void>("delete_engine", { id }),

  // Model catalog. `searchCatalog`/`listCatalogFiles` hit the HuggingFace Hub
  // API off the main thread. `downloadCatalogModel` resolves with the run's
  // generation id; progress arrives via `catalog-progress` and the result via
  // `catalog-done`.
  searchCatalog: (query?: string, sort?: string, limit?: number, token?: string | null) =>
    invoke<CatalogModel[]>("search_catalog", {
      query: query ?? null,
      sort: sort ?? null,
      limit: limit ?? null,
      token: token ?? null,
    }),
  listCatalogFiles: (repoId: string, token?: string | null) =>
    invoke<CatalogFile[]>("list_catalog_files", { repoId, token: token ?? null }),
  downloadCatalogModel: (
    repoId: string,
    file: CatalogFile,
    modelsDir: string | null,
    token?: string | null,
  ) =>
    invoke<number>("download_catalog_model", {
      repoId,
      filename: file.filename,
      urlPaths: file.url_paths,
      expectedSize: file.size,
      modelsDir,
      token: token ?? null,
    }),
  cancelCatalogDownload: () => invoke<void>("cancel_catalog_download"),

  mcpConnect: (id: string) => invoke<McpStatus>("mcp_connect", { id }),
  mcpDisconnect: (id: string) => invoke<void>("mcp_disconnect", { id }),
  mcpListTools: (id: string) => invoke<McpTool[]>("mcp_list_tools", { id }),
  mcpCallTool: (id: string, name: string, args: Record<string, unknown>) =>
    invoke<unknown>("mcp_call_tool", { id, name, arguments: args }),
  mcpStatusAll: () => invoke<McpStatus[]>("mcp_status_all"),

  workspaceList: (root: string, path: string) =>
    invoke<WsEntry[]>("workspace_list", { root, path }),
  workspaceRead: (root: string, path: string, offset?: number | null, limit?: number | null) =>
    invoke<WsRead>("workspace_read", { root, path, offset: offset ?? null, limit: limit ?? null }),
  workspaceWrite: (root: string, path: string, content: string) =>
    invoke<WsWrite>("workspace_write", { root, path, content }),
  workspaceEdit: (
    root: string,
    path: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean,
  ) =>
    invoke<WsEdit>("workspace_edit", {
      root,
      path,
      oldString,
      newString,
      replaceAll: replaceAll ?? false,
    }),
  workspaceSearch: (
    root: string,
    query: string,
    path?: string | null,
    maxResults?: number | null,
  ) =>
    invoke<WsSearch>("workspace_search", {
      root,
      query,
      path: path ?? null,
      maxResults: maxResults ?? null,
    }),
  workspaceFind: (root: string, pattern: string, maxResults?: number | null) =>
    invoke<WsFind>("workspace_find", { root, pattern, maxResults: maxResults ?? null }),

  pickFolder: (title = "Select a directory") =>
    open({ directory: true, multiple: false, title }) as Promise<string | null>,
  pickFile: (title = "Select GGUF model file", extensions = ["gguf"]) =>
    open({
      directory: false,
      multiple: false,
      title,
      filters: [{ name: "GGUF model", extensions }],
    }) as Promise<string | null>,
  pickAudio: (title = "Select an audio file") =>
    open({
      directory: false,
      multiple: false,
      title,
      // llama-server's input_audio accepts wav/mp3 only.
      filters: [{ name: "Audio", extensions: ["wav", "mp3"] }],
    }) as Promise<string | null>,
  pickImage: (title = "Select an image file") =>
    open({
      directory: false,
      multiple: false,
      title,
      // Formats llama.cpp's vision projectors decode.
      filters: [{ name: "Image", extensions: ["jpg", "jpeg", "png", "gif", "webp"] }],
    }) as Promise<string | null>,
};
