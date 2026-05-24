import type { StateCreator } from "zustand";
import {
  api,
  defaultSessionConfig,
  type McpServerConfig,
  type McpStatus,
  type McpTool,
  type Settings,
} from "../../lib/api";
import { log } from "../../lib/logger";
import { persistChats } from "../persist";
import type { PendingToolApproval } from "../types";
import type { AppStore } from "../store";

export type McpSlice = {
  mcpStatuses: Record<string, McpStatus>;
  mcpTools: Record<string, McpTool[]>;
  pendingToolApproval: PendingToolApproval | null;
  _approvalResolve: ((d: "allow" | "deny") => void) | null;

  // Computed-style getter via selector for back-compat: settings.mcp_servers.
  // (Exposed as a selector for components — `useAppStore(s => s.settings.mcp_servers)`.)
  mcpUpsertServer: (cfg: McpServerConfig) => Promise<void>;
  mcpDeleteServer: (id: string) => Promise<void>;
  mcpConnect: (id: string) => Promise<void>;
  mcpDisconnect: (id: string) => Promise<void>;
  mcpRefreshStatus: () => Promise<void>;
  requestApproval: (req: PendingToolApproval) => Promise<"allow" | "deny">;
  approveTool: (id: string, decision: "allow" | "deny", remember?: boolean) => void;
};

export const createMcpSlice: StateCreator<AppStore, [], [], McpSlice> = (set, get) => ({
  mcpStatuses: {},
  mcpTools: {},
  pendingToolApproval: null,
  _approvalResolve: null,

  mcpUpsertServer: async (cfg) => {
    const settings = get().settings;
    const exists = settings.mcp_servers.some((s) => s.id === cfg.id);
    const mcp_servers = exists
      ? settings.mcp_servers.map((s) => (s.id === cfg.id ? cfg : s))
      : [...settings.mcp_servers, cfg];
    const updated: Settings = { ...settings, mcp_servers };
    await api.saveSettings(updated);
    get().setSettings(updated);
  },

  mcpDeleteServer: async (id) => {
    try {
      await api.mcpDisconnect(id);
    } catch {
      /* ignore — may not be connected */
    }
    const settings = get().settings;
    const updated: Settings = {
      ...settings,
      mcp_servers: settings.mcp_servers.filter((s) => s.id !== id),
    };
    await api.saveSettings(updated);
    get().setSettings(updated);
    set((s) => {
      const statuses = { ...s.mcpStatuses };
      delete statuses[id];
      const tools = { ...s.mcpTools };
      delete tools[id];
      return { mcpStatuses: statuses, mcpTools: tools };
    });
  },

  mcpConnect: async (id) => {
    try {
      const status = await api.mcpConnect(id);
      set((s) => ({ mcpStatuses: { ...s.mcpStatuses, [id]: status } }));
      try {
        const tools = await api.mcpListTools(id);
        set((s) => ({ mcpTools: { ...s.mcpTools, [id]: tools } }));
      } catch (e) {
        log.warn("mcp", `list_tools after connect failed`, { id, error: String(e) });
      }
      log.info("mcp", `connected ${id}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error("mcp", `connect failed`, { id, error: msg });
      set((s) => ({
        mcpStatuses: {
          ...s.mcpStatuses,
          [id]: { id, connected: false, error: msg, tool_count: 0, server_name: null },
        },
      }));
      throw e;
    }
  },

  mcpDisconnect: async (id) => {
    await api.mcpDisconnect(id);
    set((s) => {
      const tools = { ...s.mcpTools };
      delete tools[id];
      return {
        mcpStatuses: {
          ...s.mcpStatuses,
          [id]: { id, connected: false, error: null, tool_count: 0, server_name: null },
        },
        mcpTools: tools,
      };
    });
  },

  mcpRefreshStatus: async () => {
    try {
      const statuses = await api.mcpStatusAll();
      const byId: Record<string, McpStatus> = {};
      for (const s of statuses) byId[s.id] = s;
      set({ mcpStatuses: byId });
      for (const s of statuses) {
        if (s.connected && !get().mcpTools[s.id]) {
          try {
            const tools = await api.mcpListTools(s.id);
            set((cur) => ({ mcpTools: { ...cur.mcpTools, [s.id]: tools } }));
          } catch (e) {
            log.warn("mcp", `list_tools failed`, { id: s.id, error: String(e) });
          }
        }
      }
    } catch (e) {
      log.warn("mcp", "status_all failed", { error: String(e) });
    }
  },

  requestApproval: (req) => {
    return new Promise<"allow" | "deny">((resolve) => {
      set({ _approvalResolve: resolve, pendingToolApproval: req });
    });
  },

  approveTool: (_id, decision, remember) => {
    const { _approvalResolve: cb, pendingToolApproval: req, currentChatId } = get();
    set({ _approvalResolve: null, pendingToolApproval: null });
    if (remember && req && currentChatId) {
      const key = `${req.serverId}:${req.toolName}`;
      set((s) => {
        const next = s.chats.map((c) => {
          if (c.id !== currentChatId) return c;
          const cfg = c.config ?? defaultSessionConfig();
          const per_tool = { ...cfg.tool_permissions.per_tool, [key]: decision };
          return {
            ...c,
            config: { ...cfg, tool_permissions: { ...cfg.tool_permissions, per_tool } },
            updated_at: Date.now(),
          };
        });
        persistChats(next);
        return { chats: next };
      });
    }
    cb?.(decision);
  },
});
