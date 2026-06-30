import { vi } from "vitest";
import { resetAppStore } from "./store";
import { api, type Settings, type ChatSession } from "../lib/api";
import { EMPTY_SETTINGS } from "./slices/settingsSlice";

export { useAppStore, resetAppStore } from "./store";

export function freshStore() {
  resetAppStore();
  vi.clearAllMocks();
}

// Build a Settings object overriding only the fields the caller cares about.
export function makeSettings(patch: Partial<Settings> = {}): Settings {
  return { ...EMPTY_SETTINGS, ...patch };
}

export function makeChat(over: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "c1",
    title: "t",
    created_at: 1,
    updated_at: 1,
    pinned: false,
    messages: [],
    ...over,
  };
}

// Spy on every Tauri-facing api.* method with a default resolved value, so
// slice actions that fire-and-forget persistence calls don't blow up.
export function stubApi() {
  vi.spyOn(api, "saveSettings").mockResolvedValue(undefined);
  vi.spyOn(api, "saveChats").mockResolvedValue(undefined);
  vi.spyOn(api, "loadSettings").mockResolvedValue(EMPTY_SETTINGS);
  vi.spyOn(api, "loadChats").mockResolvedValue([]);
  vi.spyOn(api, "addRecentDir").mockResolvedValue(EMPTY_SETTINGS);
  vi.spyOn(api, "addRecentModelsDir").mockResolvedValue(EMPTY_SETTINGS);
  vi.spyOn(api, "scanBuild").mockResolvedValue({
    path: "/b",
    resolved_path: "/b",
    detected: true,
    version: "v1",
    commit: null,
    backend_badges: [],
    binaries: [],
  });
  vi.spyOn(api, "scanModels").mockResolvedValue({
    path: "/m",
    total_gb: 0,
    count: 0,
    owners: 0,
    tree: [],
  });
  vi.spyOn(api, "inspectGguf").mockResolvedValue({
    path: "/m/model.gguf",
    gguf_version: 3,
    tensor_count: 0,
    metadata_count: 0,
    architecture: "llama",
    general_name: null,
    context_length: null,
    mtp_support: false,
    size_gb: 0,
    mmproj_siblings: [],
    supports_thinking: false,
    thinking_style: null,
  });
  vi.spyOn(api, "hwSnapshot").mockResolvedValue({
    cpu_util: 0,
    cpu_name: "",
    cpu_cores: 0,
    cpu_freq_ghz: 0,
    ram_total_gb: 0,
    ram_used_gb: 0,
    swap_used_gb: 0,
    gpus: [],
    gpu_backend: "",
  });
  vi.spyOn(api, "startServer").mockResolvedValue({
    pid: 1,
    port: 8080,
    started_at: 1,
    binary: "llama-server",
  });
  vi.spyOn(api, "stopServer").mockResolvedValue(undefined);
  vi.spyOn(api, "serverStatus").mockResolvedValue({
    running: false,
    ready: false,
    info: null,
  });
  vi.spyOn(api, "saveRecording").mockResolvedValue("/cache/recordings/recording.wav");
  vi.spyOn(api, "readAudioBase64").mockResolvedValue({ data: "AAAA", format: "wav" });
  vi.spyOn(api, "readImageBase64").mockResolvedValue({
    data: "AAAA",
    format: "png",
    mime: "image/png",
  });
  vi.spyOn(api, "pickFolder").mockResolvedValue(null);
  vi.spyOn(api, "pickFile").mockResolvedValue(null);
  vi.spyOn(api, "pickAudio").mockResolvedValue(null);
  vi.spyOn(api, "pickImage").mockResolvedValue(null);
  vi.spyOn(api, "mcpConnect").mockResolvedValue({
    id: "x",
    connected: true,
    error: null,
    tool_count: 0,
    server_name: null,
  });
  vi.spyOn(api, "mcpDisconnect").mockResolvedValue(undefined);
  vi.spyOn(api, "mcpListTools").mockResolvedValue([]);
  vi.spyOn(api, "mcpCallTool").mockResolvedValue("");
  vi.spyOn(api, "mcpStatusAll").mockResolvedValue([]);
  vi.spyOn(api, "workspaceList").mockResolvedValue([]);
  vi.spyOn(api, "workspaceRead").mockResolvedValue({
    path: "f.txt",
    total_lines: 0,
    start_line: 1,
    end_line: 0,
    truncated: false,
    content: "",
  });
  vi.spyOn(api, "workspaceWrite").mockResolvedValue({ path: "f.txt", bytes: 0, created: true });
  vi.spyOn(api, "workspaceEdit").mockResolvedValue({ path: "f.txt", replacements: 1 });
  vi.spyOn(api, "workspaceSearch").mockResolvedValue({
    matches: [],
    truncated: false,
    files_scanned: 0,
  });
  vi.spyOn(api, "workspaceFind").mockResolvedValue({ paths: [], truncated: false });
  vi.spyOn(api, "runBench").mockResolvedValue(1);
  vi.spyOn(api, "cancelBench").mockResolvedValue(undefined);
  vi.spyOn(api, "loadBenchRuns").mockResolvedValue([]);
  vi.spyOn(api, "saveBenchRuns").mockResolvedValue(undefined);
  vi.spyOn(api, "searchCatalog").mockResolvedValue([]);
  vi.spyOn(api, "listCatalogFiles").mockResolvedValue([]);
  vi.spyOn(api, "downloadCatalogModel").mockResolvedValue(1);
  vi.spyOn(api, "cancelCatalogDownload").mockResolvedValue(undefined);
}

// Drain microtasks so fire-and-forget persistence promises settle before the
// test inspects spy calls.
export const flush = () => new Promise<void>((r) => queueMicrotask(r));
