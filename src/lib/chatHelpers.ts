import type { ChatMessage } from "../state/types";
import type { StoredChatMessage } from "./api";

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
