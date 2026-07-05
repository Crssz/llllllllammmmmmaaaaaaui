import { describe, it, expect } from "vitest";
import {
  basename,
  fmtTime,
  imageFormatFor,
  approxTokens,
  ROLE_TAG_OVERHEAD,
  fmtN,
  precedingUserIdx,
  streamingPhase,
  estimateTokenUsage,
} from "./chatUi";
import type { ChatMessage } from "../state/types";

describe("basename", () => {
  it("returns empty string for empty input", () => {
    expect(basename("")).toBe("");
  });

  it("handles POSIX paths", () => {
    expect(basename("/home/user/model.gguf")).toBe("model.gguf");
  });

  it("handles Windows paths", () => {
    expect(basename("C:\\Users\\me\\model.gguf")).toBe("model.gguf");
  });

  it("returns a bare filename unchanged", () => {
    expect(basename("model.gguf")).toBe("model.gguf");
  });

  it("returns the whole string when a trailing separator leaves an empty tail", () => {
    // split("/").pop() on "a/b/" is "" which is falsy → falls back to p
    expect(basename("a/b/")).toBe("a/b/");
    expect(basename("C:\\a\\b\\")).toBe("C:\\a\\b\\");
  });
});

describe("fmtTime", () => {
  it("formats a timestamp as HH:MM", () => {
    // Construct a local-time date so the assertion is timezone-independent.
    const d = new Date(2020, 0, 1, 9, 5, 30);
    expect(fmtTime(d.getTime())).toBe("09:05");
  });

  it("pads single-digit hours and minutes", () => {
    const d = new Date(2020, 5, 15, 3, 7, 0);
    expect(fmtTime(d.getTime())).toBe("03:07");
  });
});

describe("imageFormatFor", () => {
  it("maps jpg and jpeg to jpeg", () => {
    expect(imageFormatFor("a.jpg")).toBe("jpeg");
    expect(imageFormatFor("a.jpeg")).toBe("jpeg");
  });

  it("passes png/gif/webp through", () => {
    expect(imageFormatFor("a.png")).toBe("png");
    expect(imageFormatFor("a.gif")).toBe("gif");
    expect(imageFormatFor("a.webp")).toBe("webp");
  });

  it("is case-insensitive", () => {
    expect(imageFormatFor("PHOTO.JPG")).toBe("jpeg");
    expect(imageFormatFor("PHOTO.PNG")).toBe("png");
  });

  it("defaults unknown extensions to png", () => {
    expect(imageFormatFor("a.bmp")).toBe("png");
    expect(imageFormatFor("a.tiff")).toBe("png");
  });

  it("defaults a path with no extension to png", () => {
    expect(imageFormatFor("noext")).toBe("png");
    expect(imageFormatFor("")).toBe("png");
  });

  it("uses only the last dot-segment", () => {
    expect(imageFormatFor("archive.tar.png")).toBe("png");
  });
});

describe("approxTokens", () => {
  it("returns 0 for empty input", () => {
    expect(approxTokens("")).toBe(0);
  });

  it("returns 0 for a nullish input", () => {
    // Runtime guard for `s?.length ?? 0`.
    expect(approxTokens(undefined as unknown as string)).toBe(0);
  });

  it("rounds up to the nearest token at the 4-char boundary", () => {
    expect(approxTokens("abcd")).toBe(1);
    expect(approxTokens("abcde")).toBe(2);
  });

  it("counts one token for 1..4 chars", () => {
    expect(approxTokens("a")).toBe(1);
  });
});

describe("fmtN", () => {
  it("returns the raw number below 1000", () => {
    expect(fmtN(0)).toBe("0");
    expect(fmtN(999)).toBe("999");
  });

  it("uses one decimal for thousands under 10k", () => {
    expect(fmtN(1000)).toBe("1.0k");
    expect(fmtN(1500)).toBe("1.5k");
    expect(fmtN(9999)).toBe("10.0k");
  });

  it("drops the decimal at 10k and above", () => {
    expect(fmtN(10_000)).toBe("10k");
    expect(fmtN(10_500)).toBe("11k");
  });
});

describe("precedingUserIdx", () => {
  const msg = (role: ChatMessage["role"]): ChatMessage => ({
    role,
    content: "",
    time: 0,
  });

  it("returns -1 when there is no preceding user message", () => {
    const msgs = [msg("system"), msg("assistant")];
    expect(precedingUserIdx(msgs, 1)).toBe(-1);
  });

  it("returns -1 at index 0", () => {
    expect(precedingUserIdx([msg("user")], 0)).toBe(-1);
  });

  it("returns -1 for an empty array", () => {
    expect(precedingUserIdx([], 0)).toBe(-1);
  });

  it("finds the nearest preceding user message", () => {
    const msgs = [msg("user"), msg("assistant"), msg("assistant")];
    expect(precedingUserIdx(msgs, 2)).toBe(0);
  });

  it("skips over tool/assistant messages to the closest user", () => {
    const msgs = [msg("user"), msg("assistant"), msg("user"), msg("tool"), msg("assistant")];
    expect(precedingUserIdx(msgs, 4)).toBe(2);
  });
});

describe("streamingPhase", () => {
  it("is responding when content is present (regardless of reasoning)", () => {
    expect(streamingPhase(true, false)).toBe("responding");
    expect(streamingPhase(true, true)).toBe("responding");
  });

  it("is thinking when only reasoning is present", () => {
    expect(streamingPhase(false, true)).toBe("thinking");
  });

  it("is prompt when neither content nor reasoning is present", () => {
    expect(streamingPhase(false, false)).toBe("prompt");
  });
});

describe("estimateTokenUsage", () => {
  const msg = (content: string): ChatMessage => ({ role: "user", content, time: 0 });

  it("returns zeros for empty history and empty draft", () => {
    const r = estimateTokenUsage([], "", 4096);
    expect(r).toEqual({ historyTokens: 0, draftTokens: 0, usedTokens: 0, pctOfCtx: 0 });
  });

  it("adds role-tag overhead per message", () => {
    // "abcd" → 1 token + 4 overhead = 5 per message.
    const r = estimateTokenUsage([msg("abcd"), msg("abcd")], "", 4096);
    expect(r.historyTokens).toBe(2 * (1 + ROLE_TAG_OVERHEAD));
    expect(r.draftTokens).toBe(0);
    expect(r.usedTokens).toBe(r.historyTokens);
  });

  it("counts no overhead for an empty draft but adds it for a non-empty one", () => {
    expect(estimateTokenUsage([], "", 4096).draftTokens).toBe(0);
    // "abcd" → 1 token + 4 overhead.
    expect(estimateTokenUsage([], "abcd", 4096).draftTokens).toBe(1 + ROLE_TAG_OVERHEAD);
  });

  it("computes pctOfCtx and guards against a zero context window", () => {
    const r = estimateTokenUsage([msg("abcd")], "", 100);
    // history = 5 tokens of 100 → 5%.
    expect(r.pctOfCtx).toBeCloseTo(5, 5);
    expect(estimateTokenUsage([msg("abcd")], "", 0).pctOfCtx).toBe(0);
  });

  it("crosses the 80% and 95% thresholds as expected", () => {
    // ctx = 100. history tokens = ceil(len/4) + 4.
    // 48 chars → 12 + 4 = 16 tokens → 16% (below 80).
    expect(estimateTokenUsage([msg("x".repeat(48))], "", 100).pctOfCtx).toBeLessThan(80);
    // 304 chars → 76 + 4 = 80 tokens → exactly 80%.
    expect(estimateTokenUsage([msg("x".repeat(304))], "", 100).pctOfCtx).toBeCloseTo(80, 5);
    // 364 chars → 91 + 4 = 95 tokens → exactly 95%.
    expect(estimateTokenUsage([msg("x".repeat(364))], "", 100).pctOfCtx).toBeCloseTo(95, 5);
  });
});
