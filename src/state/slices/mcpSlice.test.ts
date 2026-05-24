import { describe, it, expect, beforeEach, vi } from "vitest";
import { api } from "../../lib/api";
import { freshStore, makeChat, makeSettings, stubApi, useAppStore } from "../testUtils";
import type { McpServerConfig } from "../../lib/api";

function srv(over: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: "s1",
    name: "Server 1",
    transport: "stdio",
    command: "node",
    args: [],
    env: {},
    cwd: null,
    enabled: true,
    autostart: false,
    ...over,
  };
}

describe("mcp slice", () => {
  beforeEach(() => {
    freshStore();
    stubApi();
  });

  it("mcpUpsertServer adds when missing", async () => {
    await useAppStore.getState().mcpUpsertServer(srv());
    expect(useAppStore.getState().settings.mcp_servers).toHaveLength(1);
  });

  it("mcpUpsertServer replaces when present", async () => {
    useAppStore.getState().setSettings(makeSettings({ mcp_servers: [srv({ name: "old" })] }));
    await useAppStore.getState().mcpUpsertServer(srv({ name: "new" }));
    const list = useAppStore.getState().settings.mcp_servers;
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("new");
  });

  it("mcpDeleteServer removes the entry and forgets status/tools", async () => {
    useAppStore.getState().setSettings(makeSettings({ mcp_servers: [srv()] }));
    useAppStore.setState({
      mcpStatuses: { s1: { id: "s1", connected: true, error: null, tool_count: 0, server_name: null } },
      mcpTools: { s1: [] },
    });
    await useAppStore.getState().mcpDeleteServer("s1");
    expect(useAppStore.getState().settings.mcp_servers).toHaveLength(0);
    expect(useAppStore.getState().mcpStatuses.s1).toBeUndefined();
    expect(useAppStore.getState().mcpTools.s1).toBeUndefined();
  });

  it("mcpDeleteServer swallows disconnect errors", async () => {
    useAppStore.getState().setSettings(makeSettings({ mcp_servers: [srv()] }));
    vi.spyOn(api, "mcpDisconnect").mockRejectedValueOnce(new Error("not connected"));
    await expect(useAppStore.getState().mcpDeleteServer("s1")).resolves.toBeUndefined();
  });

  it("mcpConnect stores status + tools", async () => {
    vi.spyOn(api, "mcpListTools").mockResolvedValueOnce([
      { name: "t1", description: "d", input_schema: {} },
    ]);
    await useAppStore.getState().mcpConnect("s1");
    expect(useAppStore.getState().mcpStatuses.s1.connected).toBe(true);
    expect(useAppStore.getState().mcpTools.s1).toHaveLength(1);
  });

  it("mcpConnect propagates connect failure and writes an error status", async () => {
    vi.spyOn(api, "mcpConnect").mockRejectedValueOnce(new Error("refused"));
    await expect(useAppStore.getState().mcpConnect("s1")).rejects.toThrow("refused");
    expect(useAppStore.getState().mcpStatuses.s1.error).toBe("refused");
  });

  it("mcpConnect tolerates list_tools failure", async () => {
    vi.spyOn(api, "mcpListTools").mockRejectedValueOnce(new Error("no tools"));
    await useAppStore.getState().mcpConnect("s1");
    expect(useAppStore.getState().mcpStatuses.s1.connected).toBe(true);
    expect(useAppStore.getState().mcpTools.s1).toBeUndefined();
  });

  it("mcpDisconnect clears status + tools", async () => {
    useAppStore.setState({
      mcpStatuses: { s1: { id: "s1", connected: true, error: null, tool_count: 0, server_name: null } },
      mcpTools: { s1: [{ name: "t", description: null, input_schema: {} }] },
    });
    await useAppStore.getState().mcpDisconnect("s1");
    expect(useAppStore.getState().mcpStatuses.s1.connected).toBe(false);
    expect(useAppStore.getState().mcpTools.s1).toBeUndefined();
  });

  it("mcpRefreshStatus snapshots statuses and back-fills tools", async () => {
    vi.spyOn(api, "mcpStatusAll").mockResolvedValueOnce([
      { id: "s1", connected: true, error: null, tool_count: 1, server_name: null },
      { id: "s2", connected: false, error: null, tool_count: 0, server_name: null },
    ]);
    vi.spyOn(api, "mcpListTools").mockResolvedValueOnce([
      { name: "t", description: null, input_schema: {} },
    ]);
    await useAppStore.getState().mcpRefreshStatus();
    expect(useAppStore.getState().mcpStatuses.s1.connected).toBe(true);
    expect(useAppStore.getState().mcpStatuses.s2.connected).toBe(false);
    expect(useAppStore.getState().mcpTools.s1).toHaveLength(1);
    expect(useAppStore.getState().mcpTools.s2).toBeUndefined();
  });

  it("mcpRefreshStatus tolerates a status_all failure", async () => {
    vi.spyOn(api, "mcpStatusAll").mockRejectedValueOnce(new Error("boom"));
    await expect(useAppStore.getState().mcpRefreshStatus()).resolves.toBeUndefined();
  });

  it("requestApproval surfaces a pending request and resolves on approveTool", async () => {
    const p = useAppStore.getState().requestApproval({
      id: "req1",
      serverId: "s1",
      serverName: "S",
      toolName: "t",
      args: { x: 1 },
    });
    expect(useAppStore.getState().pendingToolApproval?.id).toBe("req1");
    useAppStore.getState().approveTool("req1", "allow");
    await expect(p).resolves.toBe("allow");
    expect(useAppStore.getState().pendingToolApproval).toBeNull();
  });

  it("approveTool with remember writes per-tool policy onto the current chat", () => {
    useAppStore.setState({
      chats: [makeChat({ id: "c1" })],
      currentChatId: "c1",
    });
    // Synthesise a pending approval state.
    useAppStore.getState().requestApproval({
      id: "req",
      serverId: "s1",
      serverName: "S",
      toolName: "t",
      args: {},
    });
    useAppStore.getState().approveTool("req", "allow", true);
    const cfg = useAppStore.getState().chats[0].config!;
    expect(cfg.tool_permissions.per_tool["s1:t"]).toBe("allow");
  });

  it("approveTool without remember leaves chat config untouched", () => {
    useAppStore.setState({
      chats: [makeChat({ id: "c1" })],
      currentChatId: "c1",
    });
    useAppStore.getState().requestApproval({
      id: "req",
      serverId: "s1",
      serverName: "S",
      toolName: "t",
      args: {},
    });
    useAppStore.getState().approveTool("req", "deny");
    expect(useAppStore.getState().chats[0].config ?? null).toBeNull();
  });
});
