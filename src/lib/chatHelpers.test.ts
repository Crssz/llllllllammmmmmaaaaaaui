import { describe, it, expect } from "vitest";
import {
  toView,
  fromView,
  mcpResultToText,
  deriveTitle,
  newChatId,
  splitThink,
  shapeChatBody,
  finalizeTokenStats,
  type ChatBodyParts,
} from "./chatHelpers";
import type { StoredChatMessage } from "./api";
import type { ChatMessage } from "../state/types";

describe("toView / fromView", () => {
  it("converts stored → view, dropping null tps/tokens", () => {
    const stored: StoredChatMessage = {
      role: "user",
      content: "hi",
      time: 1,
      tps: null,
      tokens: null,
      reasoning: null,
      tool_calls: null,
      tool_call_id: null,
      tool_name: null,
    };
    const v = toView([stored]);
    expect(v[0]).toMatchObject({ role: "user", content: "hi", time: 1 });
    expect(v[0].reasoning).toBeUndefined();
    expect(v[0].meta).toBeUndefined();
    expect(v[0].tool_calls).toBeUndefined();
  });

  it("packs meta only when tps or tokens is present", () => {
    const v = toView([
      { role: "assistant", content: "x", time: 2, tps: 12.3, tokens: 5 },
      { role: "assistant", content: "y", time: 3, tps: null, tokens: 7 },
    ]);
    expect(v[0].meta).toEqual({ tps: 12.3, tokens: 5 });
    expect(v[1].meta).toEqual({ tps: undefined, tokens: 7 });
  });

  it("fromView round-trips a view message into a stored one with nulls", () => {
    const view: ChatMessage = {
      role: "user",
      content: "hello",
      time: 42,
      meta: { tps: 7, tokens: 3 },
    };
    const stored = fromView(view);
    expect(stored).toEqual({
      role: "user",
      content: "hello",
      time: 42,
      tps: 7,
      tokens: 3,
      reasoning: null,
      tool_calls: null,
      tool_call_id: null,
      tool_name: null,
      audio: null,
      image: null,
    });
  });

  it("fromView preserves tool message fields", () => {
    const v: ChatMessage = {
      role: "tool",
      content: "result",
      time: 1,
      tool_call_id: "abc",
      tool_name: "foo",
    };
    const s = fromView(v);
    expect(s.tool_call_id).toBe("abc");
    expect(s.tool_name).toBe("foo");
  });
});

describe("mcpResultToText", () => {
  it("returns empty string for null/undefined", () => {
    expect(mcpResultToText(null)).toBe("");
    expect(mcpResultToText(undefined)).toBe("");
  });

  it("returns the string unchanged when input is a string", () => {
    expect(mcpResultToText("plain text")).toBe("plain text");
  });

  it("concatenates text parts of structured content", () => {
    expect(
      mcpResultToText({
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      }),
    ).toBe("first\nsecond");
  });

  it("JSON-stringifies non-text parts", () => {
    expect(
      mcpResultToText({
        content: [{ type: "image", url: "x" }],
      }),
    ).toBe('{"type":"image","url":"x"}');
  });

  it("prefixes [error] when isError is true", () => {
    expect(
      mcpResultToText({
        isError: true,
        content: [{ type: "text", text: "boom" }],
      }),
    ).toBe("[error] boom");
  });

  it("falls back to JSON when input has no content array", () => {
    expect(mcpResultToText({ foo: 1 })).toBe('{"foo":1}');
  });

  it("survives circular content entries by falling back to String()", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(mcpResultToText({ content: [cycle] })).toBe(String(cycle));
  });
});

describe("deriveTitle", () => {
  it("returns 'New chat' when no user message", () => {
    expect(deriveTitle([])).toBe("New chat");
    expect(deriveTitle([{ role: "system", content: "x", time: 1 }])).toBe("New chat");
  });

  it("uses the first user message trimmed and collapsed", () => {
    expect(deriveTitle([{ role: "user", content: "  hi   there  ", time: 1 }])).toBe("hi there");
  });

  it("truncates titles longer than 48 chars", () => {
    const long = "x".repeat(60);
    const t = deriveTitle([{ role: "user", content: long, time: 1 }]);
    expect(t).toHaveLength(48);
    expect(t.endsWith("…")).toBe(true);
  });

  it("falls back to 'New chat' when first user content is whitespace-only", () => {
    expect(deriveTitle([{ role: "user", content: "   ", time: 1 }])).toBe("New chat");
  });
});

describe("newChatId", () => {
  it("produces unique-looking ids", () => {
    const a = newChatId();
    const b = newChatId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
  });
});

describe("splitThink coverage extras", () => {
  it("preserves text between multiple think blocks", () => {
    const r = splitThink("p<think>r1</think>m<think>r2</think>s");
    expect(r.content).toBe("pms");
    expect(r.reasoning).toBe("r1r2");
  });
});

describe("shapeChatBody", () => {
  function baseParts(over: Partial<ChatBodyParts> = {}): ChatBodyParts {
    return {
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      attachTemplateKwargs: false,
      chatTemplate: null,
      reasoningEnabled: true,
      hipfireTag: "qwen3.6:27b",
      ...over,
    };
  }

  it("llama: sends model 'local', stream_options, and no hipfire fields", () => {
    const body = shapeChatBody("llama", baseParts());
    expect(body.model).toBe("local");
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.tools).toBeUndefined();
  });

  it("llama: attaches chat_template_kwargs and chat_template when requested", () => {
    const body = shapeChatBody(
      "llama",
      baseParts({ attachTemplateKwargs: true, chatTemplate: "tmpl-x", reasoningEnabled: false }),
    );
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.chat_template).toBe("tmpl-x");
  });

  it("llama: omits chat_template when it's empty/whitespace", () => {
    const body = shapeChatBody("llama", baseParts({ chatTemplate: "   " }));
    expect(body.chat_template).toBeUndefined();
  });

  it("llama: includes tools only when non-empty", () => {
    const withTools = shapeChatBody(
      "llama",
      baseParts({ tools: [{ type: "function", function: { name: "t", parameters: {} } }] }),
    );
    expect(withTools.tools).toHaveLength(1);
    const withoutTools = shapeChatBody("llama", baseParts({ tools: [] }));
    expect(withoutTools.tools).toBeUndefined();
  });

  it("hipfire: sends model as the configured tag, stream_options for usage, no tools, no chat_template*", () => {
    const body = shapeChatBody(
      "hipfire",
      baseParts({
        tools: [{ type: "function", function: { name: "t", parameters: {} } }],
        attachTemplateKwargs: true,
        chatTemplate: "tmpl-x",
        hipfireTag: "qwen3.6:27b",
      }),
    );
    expect(body.model).toBe("qwen3.6:27b");
    expect(body.stream).toBe(true);
    // CONFIRMED live: hipfire emits a real closing usage frame, so it's
    // requested the same as llama (see finalizeTokenStats).
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.tools).toBeUndefined();
    expect(body.chat_template).toBeUndefined();
    expect(body.chat_template_kwargs).toBeUndefined();
    expect(body.messages).toEqual(baseParts().messages);
  });

  it("hipfire: sends an empty-string model when no tag is configured", () => {
    const body = shapeChatBody("hipfire", baseParts({ hipfireTag: "" }));
    expect(body.model).toBe("");
  });
});

describe("finalizeTokenStats", () => {
  it("prefers the usage frame when present, regardless of allowEstimate", () => {
    const r = finalizeTokenStats({
      usageTokens: 42,
      contentChunks: 999,
      firstContentAt: 0,
      lastContentAt: 100,
      totalElapsedSec: 2,
      allowEstimate: false,
    });
    expect(r.tokens).toBe(42);
    expect(r.tps).toBe(21);
  });

  it("usage frame with zero tokens yields null tps (avoids 0/x weirdness or div-by-zero)", () => {
    const r = finalizeTokenStats({
      usageTokens: 0,
      contentChunks: 0,
      firstContentAt: null,
      lastContentAt: null,
      totalElapsedSec: 2,
      allowEstimate: false,
    });
    expect(r.tokens).toBe(0);
    expect(r.tps).toBeNull();
  });

  // Both llama and hipfire pass allowEstimate=false at their call sites (see
  // chatSlice.ts) — CONFIRMED live that hipfire, like llama, always sends a
  // real usage frame on a normal completed round. A missing usage frame
  // (abort / mid-stream error, either engine) must report null/null rather
  // than fabricating a count from chunks.
  it("without usage and allowEstimate=false reports null/null rather than fabricating a count", () => {
    const r = finalizeTokenStats({
      usageTokens: null,
      contentChunks: 12,
      firstContentAt: 0,
      lastContentAt: 500,
      totalElapsedSec: 1,
      allowEstimate: false,
    });
    expect(r.tokens).toBeNull();
    expect(r.tps).toBeNull();
  });

  // The allowEstimate=true path below is kept as a defensive fallback in the
  // function itself — no current call site passes true — exercised here so
  // the mechanism doesn't silently rot if it's ever needed again.
  it("defensive fallback: allowEstimate=true without usage falls back to a chunk-count estimate", () => {
    const r = finalizeTokenStats({
      usageTokens: null,
      contentChunks: 20,
      firstContentAt: 1000,
      lastContentAt: 2000,
      totalElapsedSec: 1.5,
      allowEstimate: true,
    });
    expect(r.tokens).toBe(20);
    // 20 chunks over (2000-1000)ms = 1s → 20 tok/s.
    expect(r.tps).toBe(20);
  });

  it("defensive fallback estimate: zero-output stream yields null/null, never NaN/Infinity", () => {
    const r = finalizeTokenStats({
      usageTokens: null,
      contentChunks: 0,
      firstContentAt: null,
      lastContentAt: null,
      totalElapsedSec: 1,
      allowEstimate: true,
    });
    expect(r.tokens).toBeNull();
    expect(r.tps).toBeNull();
  });

  it("defensive fallback estimate: identical first/last timestamps yields a token count but null tps", () => {
    const r = finalizeTokenStats({
      usageTokens: null,
      contentChunks: 5,
      firstContentAt: 1000,
      lastContentAt: 1000,
      totalElapsedSec: 1,
      allowEstimate: true,
    });
    expect(r.tokens).toBe(5);
    expect(r.tps).toBeNull();
  });
});
