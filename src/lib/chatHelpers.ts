import type { ChatMessage } from "../state/types";
import type { EngineKind, StoredChatMessage } from "./api";

export function toView(msgs: StoredChatMessage[]): ChatMessage[] {
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
    audio: m.audio ?? undefined,
    image: m.image ?? undefined,
  }));
}

export function fromView(m: ChatMessage): StoredChatMessage {
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
    audio: m.audio ?? null,
    image: m.image ?? null,
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

export function newChatId(): string {
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

export function deriveTitle(messages: StoredChatMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  if (!first) return "New chat";
  const t = first.content.trim().replaceAll(/\s+/g, " ");
  return t.length > 48 ? t.slice(0, 47) + "…" : t || "New chat";
}

/** The assembled request pieces, engine-agnostic; `shapeChatBody` turns them
 *  into the wire body each engine actually accepts. */
export type ChatBodyParts = {
  messages: Array<Record<string, unknown>>;
  tools: Array<{
    type: "function";
    function: { name: string; description?: string; parameters: unknown };
  }>;
  /** llama only: attach `chat_template_kwargs: { enable_thinking }`. Already
   *  gated by the caller (jinja on, non-multimodal turn, template supports it). */
  attachTemplateKwargs: boolean;
  /** llama only: a per-session chat_template override (trimmed-empty → omitted). */
  chatTemplate: string | null;
  /** Reasoning toggle state — llama routes it through chat_template_kwargs.
   *  hipfire has no documented request-side reasoning toggle (see
   *  shapeChatBody's TODO), so this is unused on that branch. */
  reasoningEnabled: boolean;
  /** The hipfire tag to serve as `model` in the request body (the configured
   *  hipfire_flags.tag) — ignored for llama, which always sends "local". */
  hipfireTag: string;
};

/**
 * Produce the `/v1/chat/completions` request body for the active engine.
 *
 * llama-server (the default) gets exactly the historical body: `model:"local"`,
 * `stream_options` for the usage frame, and the jinja `chat_template_kwargs` /
 * `chat_template` fields when the caller says so.
 *
 * hipfire is OpenAI-compatible. Facts below are from LIVE verification against
 * a running hipfire server (real HTTP captures), not documentation guesses:
 *   - `model` MUST be the configured hipfire tag, not "local" — CONFIRMED:
 *     sending "local" returns HTTP 404 "model not found" (hipfire serves
 *     exactly one model per `serve <tag>` and requires that tag as `model`).
 *   - hipfire DOES emit a real closing `usage` frame, in both streaming and
 *     non-streaming responses — CONFIRMED: the final SSE frame before
 *     `data: [DONE]` carried `"usage":{"prompt_tokens":24,
 *     "completion_tokens":160,...}` alongside a native
 *     `"timings":{"decode_tok_s":90.7,...}`. So `stream_options` is requested
 *     here the same as for llama (see `finalizeTokenStats`, which no longer
 *     needs to estimate from chunk counts for hipfire).
 *   - llama's `chat_template*` fields are llama-server-specific (jinja
 *     template overrides) and are not sent to hipfire.
 *   - tool-call streaming is CONFIRMED unsupported: hipfire has no structured
 *     tool-calling — a `tools` request returns a raw `<tool_call>` TEXT token
 *     in the content stream, not an OpenAI `delta.tool_calls` object. Tools
 *     stay gated off for hipfire; this is settled behavior, not an open
 *     question. image_url/input_audio content parts remain untested (no VL
 *     model / no live restart available) — still gated off, text model only
 *     (chatSlice drops media attachments for hipfire before this is called).
 */
export function shapeChatBody(engine: EngineKind, parts: ChatBodyParts): Record<string, unknown> {
  const { messages, tools, attachTemplateKwargs, chatTemplate, hipfireTag } = parts;

  if (engine === "hipfire") {
    // CONFIRMED (live verification): hipfire has no structured tool-calling —
    // a `tools` request returns a raw `<tool_call>` TEXT token, not an
    // OpenAI `tool_calls` delta object. Tools stay gated off for hipfire.
    // TODO(hipfire-verify): still unconfirmed whether hipfire exposes a
    // request-side reasoning toggle at all (llama's chat_template_kwargs.
    // enable_thinking is a jinja-template mechanism specific to llama-server)
    // — until confirmed, don't send it; supported hipfire models are
    // documented as hybrid-thinking, so reasoning may simply always be on.
    return {
      model: hipfireTag,
      stream: true,
      stream_options: { include_usage: true },
      messages,
    };
  }
  const { reasoningEnabled } = parts;

  const body: Record<string, unknown> = {
    model: "local",
    stream: true,
    stream_options: { include_usage: true },
    messages,
  };
  if (tools.length > 0) body.tools = tools;
  if (attachTemplateKwargs) {
    body.chat_template_kwargs = { enable_thinking: reasoningEnabled };
  }
  if (chatTemplate?.trim()) {
    body.chat_template = chatTemplate;
  }
  return body;
}

/**
 * Finalize the token count + tokens-per-second for a completed streaming round.
 *
 * Both llama-server and hipfire report exact `completion_tokens` in the SSE
 * usage frame (requested via `stream_options.include_usage`), timed over the
 * whole request. CONFIRMED live for hipfire too: the final SSE frame before
 * `data: [DONE]` carried `"usage":{"completion_tokens":160,...}` alongside a
 * native `"timings":{"decode_tok_s":90.7,...}` — hipfire gives exact counts
 * like llama, not an estimate. When a usage frame is present it always wins,
 * for either engine.
 *
 * `allowEstimate` gates a chunk-count fallback for when a usage frame is
 * missing entirely. It is now kept as a defensive fallback only, not a
 * documented hipfire behavior — no call site currently passes true, since
 * both engines are confirmed to send usage on a normal completed round. A
 * missing usage frame (a user abort or a mid-stream error, on either engine)
 * reports null/null instead of fabricating a count from chunks, which are
 * NOT tokens (both engines batch/split them across SSE frames).
 */
export function finalizeTokenStats(input: {
  /** `completion_tokens` from the usage frame, or null when it wasn't sent
   *  (e.g. aborted/errored before the closing frame arrived). */
  usageTokens: number | null;
  /** How many SSE chunks carried non-empty content/reasoning_content. */
  contentChunks: number;
  /** `performance.now()` of the first/last visible chunk; null if none arrived. */
  firstContentAt: number | null;
  lastContentAt: number | null;
  /** Whole-request wall clock in seconds (used for the usage-frame path). */
  totalElapsedSec: number;
  /** Defensive fallback switch only — CONFIRMED live that both llama and
   *  hipfire send a real usage frame on a normal completed round, so no
   *  current call site passes true. An aborted/errored stream (either
   *  engine) reports null rather than a fabricated count. */
  allowEstimate: boolean;
}): { tokens: number | null; tps: number | null } {
  const {
    usageTokens,
    contentChunks,
    firstContentAt,
    lastContentAt,
    totalElapsedSec,
    allowEstimate,
  } = input;
  if (usageTokens != null) {
    const tps = usageTokens > 0 && totalElapsedSec > 0 ? usageTokens / totalElapsedSec : null;
    return { tokens: usageTokens, tps };
  }
  if (!allowEstimate) {
    return { tokens: null, tps: null };
  }
  if (contentChunks <= 0 || firstContentAt == null || lastContentAt == null) {
    return { tokens: null, tps: null };
  }
  const genSec = (lastContentAt - firstContentAt) / 1000;
  const tps = genSec > 0 ? contentChunks / genSec : null;
  return { tokens: contentChunks, tps };
}
