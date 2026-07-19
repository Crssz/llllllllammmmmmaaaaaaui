import type { StateCreator } from "zustand";
import { fetch as hipfireFetch } from "@tauri-apps/plugin-http";
import {
  api,
  defaultSessionConfig,
  type AudioAttachment,
  type ImageAttachment,
  type ChatPreset,
  type ChatSession,
  type ChatSessionConfig,
  type Settings,
  type StoredChatMessage,
  type ToolCall,
  type ToolPermission,
} from "../../lib/api";
import { log } from "../../lib/logger";
import {
  deriveTitle,
  newChatId,
  splitThink,
  mcpResultToText,
  shapeChatBody,
  finalizeTokenStats,
} from "../../lib/chatHelpers";
import {
  WORKSPACE_SERVER_ID,
  WORKSPACE_SERVER_NAME,
  WORKSPACE_TOOLS,
  callWorkspaceTool,
  isWorkspaceReadOnlyTool,
  workspaceSystemNote,
} from "../../lib/workspaceTools";
import {
  ASK_SERVER_ID,
  ASK_SERVER_NAME,
  ASK_TOOLS,
  parseAskUserArgs,
} from "../../lib/interactionTools";
import { persistChats } from "../persist";
import type { AppStore } from "../store";
import { activeEngine } from "./serverSlice";

// Shown in place of an image/audio attachment that couldn't be sent — either
// every media read failed, or the active engine (hipfire) is text-only. Kept
// identical in both spots so a media-only user turn never travels as empty
// content (which hipfire can 400 on, poisoning every later send in that chat).
const MEDIA_UNAVAILABLE = "[attached media unavailable]";

export type ChatSlice = {
  chats: ChatSession[];
  currentChatId: string | null;
  chatPending: boolean;
  /** Id of the session a reply is currently streaming into (null when idle).
   *  chatPending alone can't tell WHICH chat streams — the user may have
   *  switched to another one whose last message is also an assistant's. */
  chatStreamingId: string | null;
  chatError: string | null;
  _chatAbort: AbortController | null;

  setChats: (chats: ChatSession[]) => void;
  setCurrentChatId: (id: string | null) => void;
  /** Set or clear the transient chat-error banner message. */
  setChatError: (message: string | null) => void;
  newChat: () => void;
  selectChat: (id: string) => void;
  deleteChat: (id: string) => void;
  togglePinChat: (id: string) => void;
  renameChat: (id: string, title: string) => void;
  /** Clone a chat (messages + config) into a new unpinned session and select it. */
  duplicateChat: (id: string) => void;
  /** Assign a chat to a workspace, or to none (null). */
  setChatWorkspace: (chatId: string, workspaceId: string | null) => void;
  /** Moves every chat in the given workspace to "no workspace" (does not
   *  delete them) — called when a workspace is deleted. */
  clearWorkspaceFromChats: (workspaceId: string) => void;
  editMessage: (chatId: string, index: number, content: string) => void;
  deleteMessage: (chatId: string, index: number) => void;
  resendFromMessage: (chatId: string, index: number) => Promise<void>;
  sendChat: (
    content: string,
    audio?: AudioAttachment | null,
    image?: ImageAttachment | null,
  ) => Promise<void>;
  cancelChat: () => void;

  updateSessionConfig: (chatId: string, patch: Partial<ChatSessionConfig>) => void;
  applyPresetToSession: (chatId: string, presetId: string) => void;
  saveSessionAsPreset: (chatId: string, name: string) => Promise<void>;
  updatePreset: (id: string, patch: Partial<ChatPreset>) => Promise<void>;
  deletePreset: (id: string) => Promise<void>;
};

type RoundResult = {
  content: string;
  reasoning: string | null;
  toolCalls: ToolCall[];
  tokens: number | null;
  tps: number | null;
  error: string | null;
};

function mutateChats(
  state: { chats: ChatSession[] },
  fn: (chats: ChatSession[]) => ChatSession[],
): ChatSession[] {
  const next = fn(state.chats);
  persistChats(next);
  return next;
}

export const createChatSlice: StateCreator<AppStore, [], [], ChatSlice> = (set, get) => {
  // Build a fresh blank session, stamped with the active workspace (if any)
  // and seeded with that workspace's default config — a one-time copy, not a
  // live link (mirrors saveSessionAsPreset's `{ ...config, preset_id: null }`).
  const buildBlankSession = (): ChatSession => {
    const id = newChatId();
    const now = Date.now();
    const workspaceId = get().currentWorkspaceId;
    const workspace = workspaceId
      ? get().settings.workspaces.find((w) => w.id === workspaceId)
      : undefined;
    return {
      id,
      title: "New chat",
      created_at: now,
      updated_at: now,
      pinned: false,
      workspace_id: workspaceId ?? null,
      messages: [],
      config: workspace ? { ...workspace.config, preset_id: null } : undefined,
    };
  };

  // Patch the in-progress assistant message without persisting (called many
  // times per second while streaming).
  const patchAssistantContent = (chatId: string, content: string, reasoning: string | null) => {
    set((s) => ({
      chats: s.chats.map((c) => {
        if (c.id !== chatId) return c;
        const last = c.messages.at(-1);
        if (last?.role !== "assistant") return c;
        return {
          ...c,
          messages: c.messages.slice(0, -1).concat({ ...last, content, reasoning }),
          updated_at: Date.now(),
        };
      }),
    }));
  };

  const finalizeAssistant = (
    chatId: string,
    content: string,
    reasoning: string | null,
    tokens: number | null,
    tps: number | null,
    toolCalls: ToolCall[] | null,
  ) => {
    set((s) => ({
      chats: mutateChats(s, (chats) =>
        chats.map((c) => {
          if (c.id !== chatId) return c;
          const last = c.messages.at(-1);
          if (last?.role !== "assistant") return c;
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
        }),
      ),
    }));
  };

  const appendToolMessage = (chatId: string, msg: StoredChatMessage) => {
    set((s) => ({
      chats: mutateChats(s, (chats) =>
        chats.map((c) =>
          c.id === chatId ? { ...c, messages: [...c.messages, msg], updated_at: Date.now() } : c,
        ),
      ),
    }));
  };

  const runChatRound = async (
    chatId: string,
    messages: StoredChatMessage[],
    tools: Array<{
      type: "function";
      function: { name: string; description?: string; parameters: unknown };
    }>,
    chatTemplate?: string | null,
  ): Promise<RoundResult> => {
    const { server, flags, reasoningEnabled, modelInfo, settings } = get();
    if (!server.running || !server.info) throw new Error("server not running");
    // Shape the request off the engine actually behind the running server
    // (activeEngine — serverSlice.ts), NOT the Configure toggle. A live
    // server that we didn't launch (loadedEngine null) or a stale toggle left
    // on "hipfire" must never mis-shape requests to a running llama-server
    // (dropped media, stripped tools, wrong model id, fabricated token count).
    const engine = activeEngine(get);
    const url = `http://127.0.0.1:${server.info.port}/v1/chat/completions`;
    const t0 = performance.now();
    const abort = new AbortController();
    set({ _chatAbort: abort });

    let rawContent = "";
    let streamedReasoning = "";
    let usageTokens: number | null = null;
    // Fallback tps inputs — used when the engine (hipfire) sends no usage
    // frame: count the chunks that carried visible output and time first→last.
    let contentChunks = 0;
    let firstContentAt: number | null = null;
    let lastContentAt: number | null = null;
    let streamError: string | null = null;
    const toolCallBuf: Map<number, ToolCall> = new Map();

    const useTemplateKwargs = flags.jinja === true;
    // TODO(hipfire-verify): image_url/input_audio media support is still an
    // open question — untested, text model only (no VL/multimodal hipfire
    // model or live restart was available to confirm either way). Until
    // verified live, media attachments are dropped for hipfire and the
    // message travels as plain text (empty text → the MEDIA_UNAVAILABLE
    // placeholder). The one-time "text-only" warning is raised in
    // streamReply (once per send, for the new turn only) — NOT here, since
    // runChatRound re-runs per tool round and would otherwise toast on every
    // round.
    const allowMedia = engine !== "hipfire";
    const hasMedia = messages.some((m) => m.role === "user" && (m.audio?.path || m.image?.path));
    // Resolve image/audio attachments to base64 just before sending. Done in
    // one pass (await Promise.all) so the round still streams sequentially but
    // reads overlap if multiple messages carry media (rare — usually the last).
    const apiMessages: Array<Record<string, unknown>> = await Promise.all(
      messages.map(async (m) => {
        const out: Record<string, unknown> = { role: m.role };
        if (allowMedia && m.role === "user" && (m.image?.path || m.audio?.path)) {
          // Multi-part content: text first (if any), then image, then audio —
          // an empty text part can confuse some templates, so it's omitted
          // when the user attached media without typing anything. Each read is
          // best-effort: a vanished file falls back to text so the round still
          // runs rather than hard-failing mid-stream.
          const parts: Array<Record<string, unknown>> = [];
          if (m.content) parts.push({ type: "text", text: m.content });
          if (m.image?.path) {
            try {
              const payload = await api.readImageBase64(m.image.path);
              parts.push({
                type: "image_url",
                image_url: { url: `data:${payload.mime};base64,${payload.data}` },
              });
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              log.warn("chat", `image read failed, skipping attachment`, {
                path: m.image.path,
                error: msg,
              });
            }
          }
          if (m.audio?.path) {
            try {
              const payload = await api.readAudioBase64(m.audio.path);
              parts.push({
                type: "input_audio",
                input_audio: { data: payload.data, format: payload.format },
              });
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              log.warn("chat", `audio read failed, skipping attachment`, {
                path: m.audio.path,
                error: msg,
              });
            }
          }
          // If every media read failed and there was no text, send a marker so
          // the message isn't an empty content array.
          if (parts.length === 0) {
            parts.push({ type: "text", text: MEDIA_UNAVAILABLE });
          }
          out.content = parts;
        } else {
          // Media was dropped for this turn (hipfire is text-only). A user
          // message that carried ONLY an attachment would otherwise send
          // content:"" — which hipfire can 400 on, and since it stays in
          // history it poisons every later send in the chat. Reuse the llama
          // placeholder so the turn still travels as non-empty text.
          const droppedMedia =
            !allowMedia && m.role === "user" && Boolean(m.image?.path || m.audio?.path);
          out.content = droppedMedia && !m.content ? MEDIA_UNAVAILABLE : m.content;
        }
        if (m.tool_calls && m.tool_calls.length > 0) out.tool_calls = m.tool_calls;
        if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
        if (m.tool_name) out.name = m.tool_name;
        return out;
      }),
    );
    // Decide whether to attach chat_template_kwargs (llama only). Two guards:
    //   1) OMIT on multimodal turns: with an audio/image part, passing
    //      `chat_template_kwargs` (e.g. enable_thinking:false) makes some
    //      llama.cpp builds crash right after media processing (observed on
    //      b9529, gemma "peg-gemma4" → server dies → "network error"). The
    //      Audio/Transcribe tab works precisely because it never sends it.
    //   2) OMIT when the loaded model's chat template doesn't reference
    //      `enable_thinking` (supports_thinking === false) — the field would
    //      be a no-op at best and risky at worst. Unknown (null modelInfo) →
    //      keep sending, matching prior behaviour.
    // shapeChatBody rewrites all of this for hipfire (model:<tag>,
    // stream_options for the CONFIRMED usage frame, no chat_template*, no
    // chat_template_kwargs — see its doc comment).
    const modelLacksThinking = modelInfo?.supports_thinking === false;
    const body = shapeChatBody(engine, {
      messages: apiMessages,
      tools,
      attachTemplateKwargs: useTemplateKwargs && !hasMedia && !modelLacksThinking,
      chatTemplate: chatTemplate ?? null,
      reasoningEnabled,
      hipfireTag: String((settings.hipfire_flags as Record<string, unknown>)?.tag ?? ""),
    });

    try {
      // hipfire's daemon has no CORS support (no OPTIONS route, no
      // Access-Control-* headers — see live-verification-checklist.md), so
      // the webview's global fetch always fails its preflight. Route hipfire
      // requests through the plugin fetch instead: its JS surface is
      // fetch/Response-identical (streaming body, AbortSignal) but the
      // request actually executes via reqwest in the Rust process, where
      // CORS doesn't apply. llama-server implements CORS, so llama rounds
      // keep using the global fetch exactly as before.
      const doFetch = engine === "hipfire" ? hipfireFetch : fetch;
      const res = await doFetch(url, {
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
            let visibleChunk = false;
            if (typeof delta.content === "string" && delta.content.length > 0) {
              rawContent += delta.content;
              touched = true;
              visibleChunk = true;
            }
            // CONFIRMED (live verification): hipfire's reasoning arrives via
            // `delta.reasoning_content`, the same field name as llama-server,
            // in both streamed and non-streamed responses. This parsing is
            // already engine-agnostic, so no branch is needed.
            if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
              streamedReasoning += delta.reasoning_content;
              touched = true;
              visibleChunk = true;
            }
            // Track visible-output chunks for the no-usage (hipfire) tps fallback.
            if (visibleChunk) {
              const at = performance.now();
              if (firstContentAt === null) firstContentAt = at;
              lastContentAt = at;
              contentChunks++;
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
      // Global fetch rejects an aborted read with a DOMException named
      // "AbortError". The plugin fetch (hipfire path) does NOT: per
      // node_modules/@tauri-apps/plugin-http/dist-js/index.js it either
      // throws `new Error('Request cancelled')` (name "Error") or, for the
      // common mid-stream case, calls `controller.error('Request cancelled')`
      // — rejecting with the bare STRING, not an Error at all. Treat
      // abort.signal.aborted as the source of truth (it's set by our own
      // cancelChat) so a hipfire Stop is classified the same as a llama Stop
      // regardless of what shape the underlying fetch throws.
      const msg = e instanceof Error ? e.message : String(e);
      if ((e as { name?: string })?.name === "AbortError" || abort.signal.aborted) {
        log.info("chat", "request aborted by user");
        streamError = "aborted";
      } else {
        streamError = msg;
        log.error("chat", "request failed", { error: msg, url });
      }
    } finally {
      set({ _chatAbort: null });
    }

    const elapsed = (performance.now() - t0) / 1000;
    // CONFIRMED (live verification): hipfire emits a real closing usage frame
    // just like llama — a streamed completion's final SSE frame before
    // `[DONE]` carried `"usage":{"completion_tokens":160,...}`. So neither
    // engine estimates from chunk counts anymore; allowEstimate is false for
    // both, and a stream that ends without a usage frame (abort / mid-stream
    // error, either engine) reports null rather than a fabricated count.
    // finalizeTokenStats never yields NaN/Infinity.
    const { tokens, tps } = finalizeTokenStats({
      usageTokens,
      contentChunks,
      firstContentAt,
      lastContentAt,
      totalElapsedSec: elapsed,
      allowEstimate: false,
    });
    const split = splitThink(rawContent);
    const reasoning =
      (streamedReasoning + (split.reasoning ? "\n" + split.reasoning : "")).trim() || null;
    const toolCalls = Array.from(toolCallBuf.values()).filter((tc) => tc.function.name);
    log.info(
      "chat",
      `← ${tokens ?? "?"} tokens in ${elapsed.toFixed(2)}s, ${toolCalls.length} tool_calls`,
    );
    return {
      content: split.content,
      reasoning,
      toolCalls,
      tokens,
      tps,
      error: streamError,
    };
  };

  const streamReply = async (session: ChatSession, baseMessages: StoredChatMessage[]) => {
    // Reconcile the server with the current config FIRST: if the Configure
    // flags changed since the model was loaded, this restarts llama-server with
    // the latest flags and waits for the reload, so the turn runs on the
    // current config instead of the previously-loaded one. No-op when already
    // current; the guards below still handle a not-running / not-ready server.
    const serverFresh = await get().reloadIfStale();
    if (!serverFresh) {
      set({
        chatError:
          "Server didn't come back after applying the new config — check the Configure tab.",
      });
      return;
    }
    const { server, mcpStatuses, mcpTools, settings, requestApproval, requestUserChoice } = get();
    if (!server.running || !server.info) {
      // No server running — activeEngine falls back to the Configure toggle
      // (the next-launch target), so this names whichever engine a Start
      // right now would actually launch.
      const engineName = activeEngine(get) === "hipfire" ? "hipfire" : "llama-server";
      set({ chatError: `Start ${engineName} on the Configure tab first.` });
      return;
    }
    if (!server.ready) {
      set({ chatError: "Server is still loading the model — give it a moment." });
      return;
    }
    set({ chatError: null });

    // Warn ONCE per send, and only when the NEW user turn (the message being
    // sent/resent right now — always the last of baseMessages in both callers)
    // carries media this engine can't take. hipfire media support is still an
    // open TODO(hipfire-verify) — untested, text model only — so its
    // image/audio parts are dropped in runChatRound (the turn still travels
    // as the MEDIA_UNAVAILABLE placeholder). Historical attachments from
    // earlier turns are replaced
    // silently — no toast — so we inspect only this turn, and do it here
    // rather than in runChatRound (which re-runs per tool round). Gated on
    // activeEngine (the RUNNING server), not the toggle, so a live
    // llama-server with the toggle left on "hipfire" doesn't raise a false
    // "text-only" warning for media it actually sends fine.
    const newTurn = baseMessages.at(-1);
    if (
      activeEngine(get) === "hipfire" &&
      newTurn?.role === "user" &&
      (newTurn.audio?.path || newTurn.image?.path)
    ) {
      log.notify(
        "warn",
        "chat",
        "hipfire is text-only — image/audio attachments were not sent with this message.",
      );
    }

    const cfg = session.config ?? null;
    const workspaceRoot = cfg?.workspace_root?.trim() || null;
    const composedMessages: StoredChatMessage[] = [];
    // System prompt + workspace note travel as ONE system message — some chat
    // templates mishandle multiple system turns.
    const sysParts: string[] = [];
    if (cfg?.system_prompt?.trim()) sysParts.push(cfg.system_prompt.trim());
    if (workspaceRoot) sysParts.push(workspaceSystemNote(workspaceRoot));
    if (sysParts.length > 0) {
      composedMessages.push({
        role: "system",
        content: sysParts.join("\n\n"),
        time: Date.now(),
      });
    }
    composedMessages.push(...baseMessages);

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
    if (workspaceRoot) {
      for (const t of WORKSPACE_TOOLS) {
        const exposed = `${WORKSPACE_SERVER_ID}__${t.name}`;
        tools.push({
          type: "function",
          function: { name: exposed, description: t.description, parameters: t.parameters },
        });
        toolIndex.set(exposed, { serverId: WORKSPACE_SERVER_ID, toolName: t.name });
      }
    }
    // The built-in ask_user tool is always offered so the model can ask the
    // user a multiple-choice question instead of guessing.
    for (const t of ASK_TOOLS) {
      const exposed = `${ASK_SERVER_ID}__${t.name}`;
      tools.push({
        type: "function",
        function: { name: exposed, description: t.description, parameters: t.parameters },
      });
      toolIndex.set(exposed, { serverId: ASK_SERVER_ID, toolName: t.name });
    }

    const placeholder: StoredChatMessage = { role: "assistant", content: "", time: Date.now() };
    let working: ChatSession = {
      ...session,
      title: session.messages.length === 0 ? deriveTitle(baseMessages) : session.title,
      updated_at: Date.now(),
      messages: [...baseMessages, placeholder],
    };
    set((s) => ({
      chats: mutateChats(s, (chats) => [working, ...chats.filter((c) => c.id !== working.id)]),
      currentChatId: working.id,
      chatPending: true,
      chatStreamingId: working.id,
    }));

    let liveMessages: StoredChatMessage[] = [...composedMessages];

    try {
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
        if (result.error && !result.content && !result.reasoning && result.toolCalls.length === 0) {
          finalizeAssistant(
            working.id,
            `⚠️ ${result.error}`,
            null,
            result.tokens,
            result.tps,
            null,
          );
          set({ chatError: result.error });
          break;
        }
        finalizeAssistant(
          working.id,
          result.content,
          result.reasoning,
          result.tokens,
          result.tps,
          result.toolCalls.length > 0 ? result.toolCalls : null,
        );
        if (result.error) set({ chatError: result.error });
        if (result.toolCalls.length === 0) break;

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
          const isWorkspace = sid === WORKSPACE_SERVER_ID;
          const isAsk = sid === ASK_SERVER_ID;
          const serverName = isWorkspace
            ? WORKSPACE_SERVER_NAME
            : isAsk
              ? ASK_SERVER_NAME
              : (settings.mcp_servers.find((s) => s.id === sid)?.name ?? sid);

          const perms = cfg?.tool_permissions ?? {
            default: "ask" as ToolPermission,
            per_tool: {},
          };
          // ask_user is always allowed — putting a question to the user is the
          // user-mediated action itself, so it never goes through the approval
          // gate (even under a "deny" default). Read-only workspace tools are
          // likewise auto-allowed so the model can browse without a prompt per
          // file, unless a per-tool override or "deny" default says otherwise.
          const override = perms.per_tool[`${sid}:${toolName}`];
          let policy: ToolPermission;
          if (isAsk) {
            policy = "allow";
          } else if (override) {
            policy = override;
          } else if (isWorkspace && isWorkspaceReadOnlyTool(toolName) && perms.default !== "deny") {
            policy = "allow";
          } else {
            policy = perms.default;
          }

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
            let text: string;
            if (isAsk) {
              // Pause the turn and surface a multiple-choice prompt; the tool
              // result is whatever the user picks (or a dismissal note).
              const { question, choices } = parseAskUserArgs(args);
              log.info("ask", `ask_user`, { choices: choices.length });
              const answer = await requestUserChoice({
                id: `${tc.id}_${Date.now()}`,
                question,
                choices,
              });
              text =
                answer == null
                  ? "The user dismissed the question without choosing an option."
                  : `The user selected: ${answer}`;
            } else if (isWorkspace) {
              log.info("workspace", `call ${toolName}`, { args });
              text = await callWorkspaceTool(workspaceRoot as string, toolName, args);
            } else {
              log.info("mcp", `call ${sid}/${toolName}`, { args });
              const raw = await api.mcpCallTool(sid, toolName, args);
              text = mcpResultToText(raw);
            }
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
            log.error(isAsk ? "ask" : isWorkspace ? "workspace" : "mcp", `tool call failed`, {
              server: sid,
              tool: toolName,
              error: msg,
            });
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

        const nextPlaceholder: StoredChatMessage = {
          role: "assistant",
          content: "",
          time: Date.now(),
        };
        set((s) => ({
          chats: mutateChats(s, (chats) =>
            chats.map((c) => {
              if (c.id !== working.id) return c;
              const out = {
                ...c,
                messages: [...c.messages, nextPlaceholder],
                updated_at: Date.now(),
              };
              working = out;
              return out;
            }),
          ),
        }));
      }
    } finally {
      set({ chatPending: false, chatStreamingId: null });
    }
  };

  return {
    chats: [],
    currentChatId: null,
    chatPending: false,
    chatStreamingId: null,
    chatError: null,
    _chatAbort: null,

    setChats: (chats) => set({ chats }),
    setCurrentChatId: (id) => set({ currentChatId: id }),
    setChatError: (message) => set({ chatError: message }),

    newChat: () => {
      const session = buildBlankSession();
      set((s) => ({
        chats: mutateChats(s, (chats) => [session, ...chats]),
        currentChatId: session.id,
        chatError: null,
      }));
      log.info("chat", `new session: ${session.id}`, { workspaceId: session.workspace_id });
    },

    clearWorkspaceFromChats: (workspaceId) =>
      set((s) => ({
        chats: mutateChats(s, (chats) =>
          chats.map((c) => (c.workspace_id === workspaceId ? { ...c, workspace_id: null } : c)),
        ),
      })),

    selectChat: (id) => set({ currentChatId: id, chatError: null }),

    deleteChat: (id) => {
      log.info("chat", `delete session ${id}`);
      set((s) => {
        const filtered = s.chats.filter((c) => c.id !== id);
        persistChats(filtered);
        let nextCurrent = s.currentChatId;
        if (nextCurrent === id) {
          const fallback = [...filtered].sort((a, b) => b.updated_at - a.updated_at)[0];
          nextCurrent = fallback?.id ?? null;
        }
        return { chats: filtered, currentChatId: nextCurrent };
      });
    },

    togglePinChat: (id) =>
      set((s) => ({
        chats: mutateChats(s, (chats) =>
          chats.map((c) => (c.id === id ? { ...c, pinned: !c.pinned } : c)),
        ),
      })),

    renameChat: (id, title) =>
      set((s) => ({
        chats: mutateChats(s, (chats) =>
          chats.map((c) => (c.id === id ? { ...c, title: title || "Untitled" } : c)),
        ),
      })),

    duplicateChat: (id) => {
      // Refuse while this chat streams — the clone would freeze a half-
      // streamed placeholder and yank the user off the live stream.
      if (get().chatStreamingId === id) return;
      const src = get().chats.find((c) => c.id === id);
      if (!src) return;
      const now = Date.now();
      const copy: ChatSession = {
        ...src,
        id: newChatId(),
        title: `${src.title} (copy)`,
        created_at: now,
        updated_at: now,
        pinned: false,
        messages: structuredClone(src.messages),
        config: src.config ? structuredClone(src.config) : src.config,
      };
      set((s) => ({
        chats: mutateChats(s, (chats) => [copy, ...chats]),
        currentChatId: copy.id,
        chatError: null,
      }));
      log.info("chat", `duplicated session ${id} → ${copy.id}`);
    },

    setChatWorkspace: (chatId, workspaceId) =>
      set((s) => ({
        chats: mutateChats(s, (chats) =>
          chats.map((c) => (c.id === chatId ? { ...c, workspace_id: workspaceId } : c)),
        ),
      })),

    editMessage: (chatId, index, content) => {
      set((s) => ({
        chats: mutateChats(s, (chats) =>
          chats.map((c) => {
            if (c.id !== chatId) return c;
            if (index < 0 || index >= c.messages.length) return c;
            const newMessages = c.messages.slice();
            newMessages[index] = { ...newMessages[index], content };
            return { ...c, messages: newMessages, updated_at: Date.now() };
          }),
        ),
      }));
      log.info("chat", `edit message #${index}`, { chatId });
    },

    deleteMessage: (chatId, index) => {
      set((s) => ({
        chats: mutateChats(s, (chats) =>
          chats.map((c) => {
            if (c.id !== chatId) return c;
            if (index < 0 || index >= c.messages.length) return c;
            const newMessages = c.messages.slice();
            newMessages.splice(index, 1);
            return { ...c, messages: newMessages, updated_at: Date.now() };
          }),
        ),
      }));
      log.info("chat", `delete message #${index}`, { chatId });
    },

    resendFromMessage: async (chatId, index) => {
      const session = get().chats.find((c) => c.id === chatId);
      if (!session) return;
      const msg = session.messages[index];
      if (msg?.role !== "user") {
        log.warn("chat", "resend ignored: target is not a user message");
        return;
      }
      const truncated = session.messages.slice(0, index + 1);
      log.info("chat", `resend from #${index} (truncating to ${truncated.length} msgs)`, {
        chatId,
      });
      await streamReply(session, truncated);
    },

    sendChat: async (content, audio, image) => {
      const text = content.trim();
      // Allow media-only messages: a blank prompt is fine if a clip or image
      // is attached.
      if (!text && !audio?.path && !image?.path) return;
      const { server, chats, currentChatId } = get();
      if (!server.running || !server.info) {
        const engineName = activeEngine(get) === "hipfire" ? "hipfire" : "llama-server";
        set({ chatError: `Start ${engineName} on the Configure tab first.` });
        return;
      }
      let targetSession = chats.find((c) => c.id === currentChatId) ?? null;
      if (!targetSession) {
        targetSession = buildBlankSession();
      }
      const userMsg: StoredChatMessage = {
        role: "user",
        content: text,
        time: Date.now(),
        audio: audio ?? null,
        image: image ?? null,
      };
      const baseMessages = [...targetSession.messages, userMsg];
      await streamReply(targetSession, baseMessages);
    },

    cancelChat: () => {
      const abort = get()._chatAbort;
      if (abort) {
        log.info("chat", "cancel requested");
        abort.abort();
      }
    },

    updateSessionConfig: (chatId, patch) =>
      set((s) => ({
        chats: mutateChats(s, (chats) =>
          chats.map((c) => {
            if (c.id !== chatId) return c;
            const cur = c.config ?? defaultSessionConfig();
            return { ...c, config: { ...cur, ...patch }, updated_at: Date.now() };
          }),
        ),
      })),

    applyPresetToSession: (chatId, presetId) => {
      const preset = get().settings.chat_presets.find((p) => p.id === presetId);
      if (!preset) return;
      set((s) => ({
        chats: mutateChats(s, (chats) =>
          chats.map((c) =>
            c.id === chatId
              ? {
                  ...c,
                  config: { ...preset.config, preset_id: preset.id },
                  updated_at: Date.now(),
                }
              : c,
          ),
        ),
      }));
    },

    saveSessionAsPreset: async (chatId, name) => {
      const session = get().chats.find((c) => c.id === chatId);
      if (!session) return;
      const config: ChatSessionConfig = session.config ?? defaultSessionConfig();
      const preset: ChatPreset = {
        id: `preset_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        name: name || "Untitled preset",
        created_at: Date.now(),
        config: { ...config, preset_id: null },
      };
      const settings = get().settings;
      const updated: Settings = {
        ...settings,
        chat_presets: [preset, ...settings.chat_presets].slice(0, 50),
      };
      await api.saveSettings(updated);
      get().setSettings(updated);
      get().updateSessionConfig(chatId, { preset_id: preset.id });
    },

    updatePreset: async (id, patch) => {
      const settings = get().settings;
      const updated: Settings = {
        ...settings,
        chat_presets: settings.chat_presets.map((p) => (p.id === id ? { ...p, ...patch } : p)),
      };
      await api.saveSettings(updated);
      get().setSettings(updated);
    },

    deletePreset: async (id) => {
      const settings = get().settings;
      const updated: Settings = {
        ...settings,
        chat_presets: settings.chat_presets.filter((p) => p.id !== id),
      };
      await api.saveSettings(updated);
      get().setSettings(updated);
    },
  };
};
