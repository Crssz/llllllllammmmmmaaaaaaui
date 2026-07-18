import type { ChatMessage } from "../state/types";
import type { EngineKind } from "../lib/api";

// Basename of a path, handling both Windows (\) and POSIX (/) separators.
// Shared UI helper — several screens had their own copy of this.
export function basename(p: string): string {
  if (!p) return "";
  const sep = p.includes("\\") ? "\\" : "/";
  return p.split(sep).pop() || p;
}

// The engine binary/name shown across the UI (top bar, sidebar, status bar,
// command palette) — "hipfire" when that's the engine in question, "llama-
// server" otherwise. Callers decide which EngineKind to pass: activeEngine()
// (serverSlice.ts) when describing a live/running server, settings.engine_kind
// when describing the next-launch target (e.g. a "stopped" label or preview).
export function engineBinaryName(kind: EngineKind): string {
  return kind === "hipfire" ? "hipfire" : "llama-server";
}

// `HH:MM` clock for a message timestamp.
export function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toTimeString().slice(0, 5);
}

// Map a picked image path to its canonical format. Mirrors the Rust mapping so
// the persisted attachment matches what the server will receive.
export function imageFormatFor(path: string): string {
  const ext = (path.includes(".") ? path.split(".").pop() : "")?.toLowerCase() ?? "";
  if (ext === "jpg" || ext === "jpeg") return "jpeg";
  if (ext === "png" || ext === "gif" || ext === "webp") return ext;
  return "png";
}

// We don't ship a tokenizer in the UI, so this uses the standard 4-chars-
// per-token heuristic. Decent for English; can be wired to llama-server's
// /tokenize later for accuracy.
export function approxTokens(s: string): number {
  return Math.ceil((s?.length ?? 0) / 4);
}

// Small per-message role-tag overhead added on top of the char heuristic.
export const ROLE_TAG_OVERHEAD = 4;

// Compact token count: 1.2k, 12k, or the raw number below 1000.
export function fmtN(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

// Index of the nearest preceding user message, or -1 if there is none.
// Used by "Regenerate response": resend from the nearest preceding user
// message (resendFromMessage truncates everything after it).
export function precedingUserIdx(messages: ChatMessage[], idx: number): number {
  for (let j = idx - 1; j >= 0; j--) {
    if (messages[j].role === "user") return j;
  }
  return -1;
}

// Streaming-phase derivation:
//   prompt     — request sent, server hasn't emitted any delta yet
//   thinking   — reasoning_content / <think> tokens flowing, no content yet
//   responding — actual response content flowing
export function streamingPhase(
  hasContent: boolean,
  hasReasoning: boolean,
): "prompt" | "thinking" | "responding" {
  if (hasContent) return "responding";
  if (hasReasoning) return "thinking";
  return "prompt";
}

// Approximate context-window usage for the composer badge. Uses the char
// heuristic plus a small role-tag overhead per message. historyTokens is the
// committed conversation; draftTokens the in-progress input.
export function estimateTokenUsage(
  messages: ChatMessage[],
  draft: string,
  ctxMax: number,
): {
  historyTokens: number;
  draftTokens: number;
  usedTokens: number;
  pctOfCtx: number;
} {
  const historyTokens = messages.reduce(
    (n, m) => n + approxTokens(m.content) + ROLE_TAG_OVERHEAD,
    0,
  );
  const draftTokens = approxTokens(draft) + (draft ? ROLE_TAG_OVERHEAD : 0);
  const usedTokens = historyTokens + draftTokens;
  const pctOfCtx = ctxMax > 0 ? (usedTokens / ctxMax) * 100 : 0;
  return { historyTokens, draftTokens, usedTokens, pctOfCtx };
}
