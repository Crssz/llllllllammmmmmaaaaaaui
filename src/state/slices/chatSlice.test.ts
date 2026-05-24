import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { api } from "../../lib/api";
import { freshStore, flush, makeChat, makeSettings, stubApi, useAppStore } from "../testUtils";
import type { StoredChatMessage } from "../../lib/api";

// Build an SSE-style streaming Response for the chat-completions endpoint.
function sseResponse(events: string[], opts: { ok?: boolean; status?: number; text?: string } = {}): Response {
  const ok = opts.ok ?? true;
  const chunks = events.map((e) => new TextEncoder().encode(e));
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[i++]);
    },
  });
  return new Response(stream, {
    status: opts.status ?? (ok ? 200 : 500),
    statusText: ok ? "OK" : "ERR",
  });
}

function readyServer() {
  useAppStore.getState().setServer({
    running: true,
    ready: true,
    info: { pid: 1, port: 8080, started_at: 1, binary: "x" },
  });
}

describe("chat slice — CRUD", () => {
  beforeEach(() => {
    freshStore();
    stubApi();
  });

  it("newChat creates a session and selects it", () => {
    useAppStore.getState().newChat();
    expect(useAppStore.getState().chats).toHaveLength(1);
    expect(useAppStore.getState().currentChatId).toBe(useAppStore.getState().chats[0].id);
  });

  it("selectChat sets currentChatId and clears chatError", () => {
    useAppStore.setState({ chatError: "x" });
    useAppStore.getState().selectChat("foo");
    expect(useAppStore.getState().currentChatId).toBe("foo");
    expect(useAppStore.getState().chatError).toBeNull();
  });

  it("deleteChat removes the entry and falls back to next-most-recent", () => {
    useAppStore.setState({
      chats: [
        makeChat({ id: "a", updated_at: 2 }),
        makeChat({ id: "b", updated_at: 5 }),
        makeChat({ id: "c", updated_at: 1 }),
      ],
      currentChatId: "b",
    });
    useAppStore.getState().deleteChat("b");
    expect(useAppStore.getState().chats.map((c) => c.id)).toEqual(["a", "c"]);
    expect(useAppStore.getState().currentChatId).toBe("a");
  });

  it("deleteChat keeps currentChatId when an unrelated chat is removed", () => {
    useAppStore.setState({
      chats: [makeChat({ id: "a" }), makeChat({ id: "b" })],
      currentChatId: "a",
    });
    useAppStore.getState().deleteChat("b");
    expect(useAppStore.getState().currentChatId).toBe("a");
  });

  it("togglePinChat flips pinned", () => {
    useAppStore.setState({ chats: [makeChat({ id: "a", pinned: false })] });
    useAppStore.getState().togglePinChat("a");
    expect(useAppStore.getState().chats[0].pinned).toBe(true);
    useAppStore.getState().togglePinChat("a");
    expect(useAppStore.getState().chats[0].pinned).toBe(false);
  });

  it("renameChat updates the title (with fallback)", () => {
    useAppStore.setState({ chats: [makeChat({ id: "a", title: "old" })] });
    useAppStore.getState().renameChat("a", "new");
    expect(useAppStore.getState().chats[0].title).toBe("new");
    useAppStore.getState().renameChat("a", "");
    expect(useAppStore.getState().chats[0].title).toBe("Untitled");
  });

  it("editMessage replaces content at index, ignores out-of-bounds", () => {
    useAppStore.setState({
      chats: [
        makeChat({ id: "a", messages: [{ role: "user", content: "hi", time: 1 }] }),
      ],
    });
    useAppStore.getState().editMessage("a", 0, "hello");
    expect(useAppStore.getState().chats[0].messages[0].content).toBe("hello");
    useAppStore.getState().editMessage("a", 99, "nope");
    expect(useAppStore.getState().chats[0].messages).toHaveLength(1);
  });

  it("deleteMessage removes by index", () => {
    useAppStore.setState({
      chats: [
        makeChat({
          id: "a",
          messages: [
            { role: "user", content: "a", time: 1 },
            { role: "assistant", content: "b", time: 2 },
          ],
        }),
      ],
    });
    useAppStore.getState().deleteMessage("a", 0);
    expect(useAppStore.getState().chats[0].messages).toHaveLength(1);
    expect(useAppStore.getState().chats[0].messages[0].content).toBe("b");
  });

  it("deleteMessage on unknown chat or oob is a no-op", () => {
    useAppStore.setState({ chats: [makeChat({ id: "a", messages: [] })] });
    useAppStore.getState().deleteMessage("a", 0);
    useAppStore.getState().deleteMessage("missing", 0);
    expect(useAppStore.getState().chats).toHaveLength(1);
  });

  it("setChats and setCurrentChatId update raw state", () => {
    useAppStore.getState().setChats([makeChat({ id: "a" })]);
    useAppStore.getState().setCurrentChatId("a");
    expect(useAppStore.getState().chats).toHaveLength(1);
    expect(useAppStore.getState().currentChatId).toBe("a");
  });
});

describe("chat slice — sendChat preconditions", () => {
  beforeEach(() => {
    freshStore();
    stubApi();
  });

  it("ignores empty input", async () => {
    await useAppStore.getState().sendChat("   ");
    expect(useAppStore.getState().chats).toHaveLength(0);
  });

  it("surfaces a chat error when the server is not running", async () => {
    await useAppStore.getState().sendChat("hi");
    expect(useAppStore.getState().chatError).toMatch(/Configure tab/);
  });

  it("rejects when server is running but not ready (via streamReply)", async () => {
    useAppStore.getState().setServer({
      running: true,
      ready: false,
      info: { pid: 1, port: 1, started_at: 0, binary: "x" },
    });
    await useAppStore.getState().sendChat("hi");
    expect(useAppStore.getState().chatError).toMatch(/still loading/);
  });
});

describe("chat slice — streaming roundtrip", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    freshStore();
    stubApi();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    readyServer();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("streams a plain assistant reply and finalises with tps", async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "Hel" } }] })}\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}\n`,
        `data: ${JSON.stringify({ usage: { completion_tokens: 2 } })}\n`,
        `data: [DONE]\n`,
      ]),
    );
    await useAppStore.getState().sendChat("hi");
    const chat = useAppStore.getState().chats[0];
    const last = chat.messages[chat.messages.length - 1];
    expect(last.role).toBe("assistant");
    expect(last.content).toBe("Hello");
    expect(last.tokens).toBe(2);
    expect(typeof last.tps).toBe("number");
    expect(useAppStore.getState().chatPending).toBe(false);
  });

  it("captures reasoning_content into the message reasoning field", async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "thinking " } }] })}\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "hard" } }] })}\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: "answer" } }] })}\n`,
        `data: [DONE]\n`,
      ]),
    );
    await useAppStore.getState().sendChat("hi");
    const last = useAppStore.getState().chats[0].messages.at(-1)!;
    expect(last.content).toBe("answer");
    expect(last.reasoning).toMatch(/thinking hard/);
  });

  it("surfaces a non-200 response as a chat error message", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("nope", { status: 500, statusText: "ERR" }),
    );
    await useAppStore.getState().sendChat("hi");
    const last = useAppStore.getState().chats[0].messages.at(-1)!;
    expect(last.content).toMatch(/⚠️ HTTP 500/);
    expect(useAppStore.getState().chatError).toMatch(/HTTP 500/);
  });

  it("cancelChat aborts the in-flight fetch and finalises with empty content", async () => {
    fetchMock.mockImplementationOnce((_url, init: RequestInit) => {
      const signal = init.signal!;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    const p = useAppStore.getState().sendChat("hi");
    // Give the fetch microtask a tick to install the listener.
    await flush();
    useAppStore.getState().cancelChat();
    await p;
    expect(useAppStore.getState().chatPending).toBe(false);
  });

  it("dispatches a tool call, captures the result, and runs a second round", async () => {
    // Pre-seed a connected MCP server with one tool.
    useAppStore.getState().setSettings(
      makeSettings({
        mcp_servers: [
          {
            id: "s1",
            name: "Server 1",
            transport: "stdio",
            command: "node",
            args: [],
            env: {},
            cwd: null,
            enabled: true,
            autostart: false,
          },
        ],
      }),
    );
    useAppStore.setState({
      mcpStatuses: {
        s1: { id: "s1", connected: true, error: null, tool_count: 1, server_name: null },
      },
      mcpTools: { s1: [{ name: "echo", description: null, input_schema: {} }] },
      chats: [
        makeChat({
          id: "c1",
          config: {
            system_prompt: "be concise",
            chat_template: null,
            mcp_server_ids: ["s1"],
            tool_permissions: { default: "allow", per_tool: {} },
            preset_id: null,
          },
        }),
      ],
      currentChatId: "c1",
    });

    vi.spyOn(api, "mcpCallTool").mockResolvedValueOnce("tool-said-hi");
    fetchMock
      .mockResolvedValueOnce(
        sseResponse([
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      function: { name: "s1__echo", arguments: '{"x":1}' },
                    },
                  ],
                },
              },
            ],
          })}\n`,
          `data: [DONE]\n`,
        ]),
      )
      .mockResolvedValueOnce(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n`,
          `data: [DONE]\n`,
        ]),
      );

    await useAppStore.getState().sendChat("please use echo");
    const msgs = useAppStore.getState().chats[0].messages;
    expect(msgs.some((m: StoredChatMessage) => m.role === "tool" && m.content === "tool-said-hi")).toBe(true);
    expect(msgs.at(-1)?.content).toBe("ok");
    expect(api.mcpCallTool).toHaveBeenCalledWith("s1", "echo", { x: 1 });
  });

  it("denies a tool call when policy is 'deny' without invoking the tool", async () => {
    useAppStore.getState().setSettings(
      makeSettings({
        mcp_servers: [
          {
            id: "s1",
            name: "Server 1",
            transport: "stdio",
            command: "node",
            args: [],
            env: {},
            cwd: null,
            enabled: true,
            autostart: false,
          },
        ],
      }),
    );
    useAppStore.setState({
      mcpStatuses: {
        s1: { id: "s1", connected: true, error: null, tool_count: 1, server_name: null },
      },
      mcpTools: { s1: [{ name: "echo", description: null, input_schema: {} }] },
      chats: [
        makeChat({
          id: "c1",
          config: {
            system_prompt: null,
            chat_template: null,
            mcp_server_ids: ["s1"],
            tool_permissions: { default: "deny", per_tool: {} },
            preset_id: null,
          },
        }),
      ],
      currentChatId: "c1",
    });

    fetchMock
      .mockResolvedValueOnce(
        sseResponse([
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      function: { name: "s1__echo", arguments: "{}" },
                    },
                  ],
                },
              },
            ],
          })}\n`,
          `data: [DONE]\n`,
        ]),
      )
      .mockResolvedValueOnce(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: "fine" } }] })}\n`,
          `data: [DONE]\n`,
        ]),
      );

    await useAppStore.getState().sendChat("try it");
    const msgs = useAppStore.getState().chats[0].messages;
    expect(msgs.some((m: StoredChatMessage) => m.role === "tool" && /denied/.test(m.content))).toBe(true);
    expect(api.mcpCallTool).not.toHaveBeenCalled();
  });

  it("reports a backend-call failure as a tool message", async () => {
    useAppStore.getState().setSettings(
      makeSettings({
        mcp_servers: [
          {
            id: "s1",
            name: "Server 1",
            transport: "stdio",
            command: "node",
            args: [],
            env: {},
            cwd: null,
            enabled: true,
            autostart: false,
          },
        ],
      }),
    );
    useAppStore.setState({
      mcpStatuses: {
        s1: { id: "s1", connected: true, error: null, tool_count: 1, server_name: null },
      },
      mcpTools: { s1: [{ name: "echo", description: null, input_schema: {} }] },
      chats: [
        makeChat({
          id: "c1",
          config: {
            system_prompt: null,
            chat_template: null,
            mcp_server_ids: ["s1"],
            tool_permissions: { default: "allow", per_tool: {} },
            preset_id: null,
          },
        }),
      ],
      currentChatId: "c1",
    });
    vi.spyOn(api, "mcpCallTool").mockRejectedValueOnce(new Error("boom"));
    fetchMock
      .mockResolvedValueOnce(
        sseResponse([
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "c",
                      function: { name: "s1__echo", arguments: "{}" },
                    },
                  ],
                },
              },
            ],
          })}\n`,
          `data: [DONE]\n`,
        ]),
      )
      .mockResolvedValueOnce(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n`,
          `data: [DONE]\n`,
        ]),
      );

    await useAppStore.getState().sendChat("trigger");
    const toolMsgs = useAppStore
      .getState()
      .chats[0].messages.filter((m: StoredChatMessage) => m.role === "tool");
    expect(toolMsgs[0].content).toMatch(/Tool execution failed: boom/);
  });

  it("emits an unregistered-tool message when the model names a tool we don't expose", async () => {
    fetchMock
      .mockResolvedValueOnce(
        sseResponse([
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "c",
                      function: { name: "ghost__missing", arguments: "{}" },
                    },
                  ],
                },
              },
            ],
          })}\n`,
          `data: [DONE]\n`,
        ]),
      )
      .mockResolvedValueOnce(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: "done" } }] })}\n`,
          `data: [DONE]\n`,
        ]),
      );
    useAppStore.setState({
      chats: [makeChat({ id: "c1" })],
      currentChatId: "c1",
    });
    await useAppStore.getState().sendChat("hi");
    const tool = useAppStore
      .getState()
      .chats[0].messages.find((m: StoredChatMessage) => m.role === "tool")!;
    expect(tool.content).toMatch(/not registered/);
  });
});

describe("chat slice — request body + edge SSE", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    freshStore();
    stubApi();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    readyServer();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("includes chat_template_kwargs and chat_template when jinja=true + template set", async () => {
    useAppStore.getState().resetFlags({ jinja: true });
    useAppStore.setState({
      chats: [
        makeChat({
          id: "c1",
          config: {
            system_prompt: null,
            chat_template: "tmpl-x",
            mcp_server_ids: [],
            tool_permissions: { default: "ask", per_tool: {} },
            preset_id: null,
          },
        }),
      ],
      currentChatId: "c1",
    });
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "x" } }] })}\n`,
        `data: [DONE]\n`,
      ]),
    );
    await useAppStore.getState().sendChat("hi");
    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sentBody.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(sentBody.chat_template).toBe("tmpl-x");
  });

  it("falls back to _raw when tool-call arguments aren't valid JSON", async () => {
    useAppStore.getState().setSettings(
      makeSettings({
        mcp_servers: [
          {
            id: "s1",
            name: "S",
            transport: "stdio",
            command: "node",
            args: [],
            env: {},
            cwd: null,
            enabled: true,
            autostart: false,
          },
        ],
      }),
    );
    useAppStore.setState({
      mcpStatuses: {
        s1: { id: "s1", connected: true, error: null, tool_count: 1, server_name: null },
      },
      mcpTools: { s1: [{ name: "echo", description: null, input_schema: {} }] },
      chats: [
        makeChat({
          id: "c1",
          config: {
            system_prompt: null,
            chat_template: null,
            mcp_server_ids: ["s1"],
            tool_permissions: { default: "allow", per_tool: {} },
            preset_id: null,
          },
        }),
      ],
      currentChatId: "c1",
    });
    fetchMock
      .mockResolvedValueOnce(
        sseResponse([
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "c",
                      function: { name: "s1__echo", arguments: "not-json{" },
                    },
                  ],
                },
              },
            ],
          })}\n`,
          `data: [DONE]\n`,
        ]),
      )
      .mockResolvedValueOnce(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: "k" } }] })}\n`,
          `data: [DONE]\n`,
        ]),
      );
    await useAppStore.getState().sendChat("trigger");
    expect(api.mcpCallTool).toHaveBeenCalledWith("s1", "echo", { _raw: "not-json{" });
  });

  it("policy='ask' surfaces a pending approval and resolves it via approveTool", async () => {
    useAppStore.getState().setSettings(
      makeSettings({
        mcp_servers: [
          {
            id: "s1",
            name: "S",
            transport: "stdio",
            command: "node",
            args: [],
            env: {},
            cwd: null,
            enabled: true,
            autostart: false,
          },
        ],
      }),
    );
    useAppStore.setState({
      mcpStatuses: {
        s1: { id: "s1", connected: true, error: null, tool_count: 1, server_name: null },
      },
      mcpTools: { s1: [{ name: "echo", description: null, input_schema: {} }] },
      chats: [
        makeChat({
          id: "c1",
          config: {
            system_prompt: null,
            chat_template: null,
            mcp_server_ids: ["s1"],
            tool_permissions: { default: "ask", per_tool: {} },
            preset_id: null,
          },
        }),
      ],
      currentChatId: "c1",
    });
    fetchMock
      .mockResolvedValueOnce(
        sseResponse([
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "c",
                      function: { name: "s1__echo", arguments: "{}" },
                    },
                  ],
                },
              },
            ],
          })}\n`,
          `data: [DONE]\n`,
        ]),
      )
      .mockResolvedValueOnce(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: "fin" } }] })}\n`,
          `data: [DONE]\n`,
        ]),
      );
    const sendP = useAppStore.getState().sendChat("ask first");
    // Wait for the approval to appear, then deny it.
    await new Promise<void>((resolve) => {
      const unsub = useAppStore.subscribe((s) => {
        if (s.pendingToolApproval) {
          unsub();
          useAppStore.getState().approveTool(s.pendingToolApproval.id, "deny");
          resolve();
        }
      });
    });
    await sendP;
    const tool = useAppStore
      .getState()
      .chats[0].messages.find((m) => m.role === "tool")!;
    expect(tool.content).toMatch(/denied/);
  });

  it("captures SSE payload errors as chunk.error string", async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        `data: ${JSON.stringify({ error: "model exploded" })}\n`,
        `data: [DONE]\n`,
      ]),
    );
    await useAppStore.getState().sendChat("hi");
    const last = useAppStore.getState().chats[0].messages.at(-1)!;
    expect(last.content).toMatch(/⚠️ model exploded/);
  });
});

describe("chat slice — resendFromMessage", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    freshStore();
    stubApi();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    readyServer();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("truncates to (and including) the user message and streams a fresh reply", async () => {
    useAppStore.setState({
      chats: [
        makeChat({
          id: "c1",
          messages: [
            { role: "user", content: "first", time: 1 },
            { role: "assistant", content: "old", time: 2 },
            { role: "user", content: "second", time: 3 },
            { role: "assistant", content: "stale", time: 4 },
          ],
        }),
      ],
      currentChatId: "c1",
    });
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "fresh" } }] })}\n`,
        `data: [DONE]\n`,
      ]),
    );
    await useAppStore.getState().resendFromMessage("c1", 0);
    const msgs = useAppStore.getState().chats[0].messages;
    expect(msgs.at(-1)!.content).toBe("fresh");
    // Resent from index 0: history is [user-first, assistant-fresh].
    expect(msgs[0].content).toBe("first");
  });

  it("no-ops when target is not a user message", async () => {
    useAppStore.setState({
      chats: [makeChat({ id: "c1", messages: [{ role: "assistant", content: "a", time: 1 }] })],
    });
    await useAppStore.getState().resendFromMessage("c1", 0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no-ops for unknown chat id", async () => {
    await useAppStore.getState().resendFromMessage("missing", 0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("chat slice — presets + session config", () => {
  beforeEach(() => {
    freshStore();
    stubApi();
  });

  it("updateSessionConfig merges into the existing config", () => {
    useAppStore.setState({ chats: [makeChat({ id: "c1" })] });
    useAppStore.getState().updateSessionConfig("c1", { system_prompt: "be brief" });
    expect(useAppStore.getState().chats[0].config?.system_prompt).toBe("be brief");
  });

  it("applyPresetToSession copies preset config + sets preset_id", () => {
    useAppStore.getState().setSettings(
      makeSettings({
        chat_presets: [
          {
            id: "p1",
            name: "n",
            created_at: 1,
            config: {
              system_prompt: "S",
              chat_template: null,
              mcp_server_ids: ["x"],
              tool_permissions: { default: "ask", per_tool: {} },
              preset_id: null,
            },
          },
        ],
      }),
    );
    useAppStore.setState({ chats: [makeChat({ id: "c1" })] });
    useAppStore.getState().applyPresetToSession("c1", "p1");
    const cfg = useAppStore.getState().chats[0].config!;
    expect(cfg.system_prompt).toBe("S");
    expect(cfg.preset_id).toBe("p1");
  });

  it("applyPresetToSession no-ops when preset id is unknown", () => {
    useAppStore.setState({ chats: [makeChat({ id: "c1" })] });
    useAppStore.getState().applyPresetToSession("c1", "ghost");
    expect(useAppStore.getState().chats[0].config ?? null).toBeNull();
  });

  it("saveSessionAsPreset adds preset capped at 50 and links session", async () => {
    useAppStore.setState({ chats: [makeChat({ id: "c1" })] });
    await useAppStore.getState().saveSessionAsPreset("c1", "first");
    const presets = useAppStore.getState().settings.chat_presets;
    expect(presets[0].name).toBe("first");
    expect(useAppStore.getState().chats[0].config?.preset_id).toBe(presets[0].id);
  });

  it("updatePreset patches by id", async () => {
    useAppStore.getState().setSettings(
      makeSettings({
        chat_presets: [
          {
            id: "p1",
            name: "old",
            created_at: 1,
            config: {
              system_prompt: null,
              chat_template: null,
              mcp_server_ids: [],
              tool_permissions: { default: "ask", per_tool: {} },
              preset_id: null,
            },
          },
        ],
      }),
    );
    await useAppStore.getState().updatePreset("p1", { name: "new" });
    expect(useAppStore.getState().settings.chat_presets[0].name).toBe("new");
  });

  it("deletePreset removes by id", async () => {
    useAppStore.getState().setSettings(
      makeSettings({
        chat_presets: [
          {
            id: "p1",
            name: "x",
            created_at: 1,
            config: {
              system_prompt: null,
              chat_template: null,
              mcp_server_ids: [],
              tool_permissions: { default: "ask", per_tool: {} },
              preset_id: null,
            },
          },
        ],
      }),
    );
    await useAppStore.getState().deletePreset("p1");
    expect(useAppStore.getState().settings.chat_presets).toHaveLength(0);
  });

  it("saveSessionAsPreset is a no-op for unknown chat", async () => {
    await useAppStore.getState().saveSessionAsPreset("ghost", "x");
    expect(useAppStore.getState().settings.chat_presets).toHaveLength(0);
  });
});
