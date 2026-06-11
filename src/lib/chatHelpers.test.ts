import { describe, it, expect } from "vitest";
import {
  toView,
  fromView,
  mcpResultToText,
  deriveTitle,
  newChatId,
  splitThink,
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
