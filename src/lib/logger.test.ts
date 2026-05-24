import { describe, it, expect, beforeEach, vi } from "vitest";
import { log, logFailure, type LogEntry, type Toast } from "./logger";

beforeEach(() => {
  log.clear();
  log.setLevel("debug");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
});

describe("logger", () => {
  it("records entries across all four levels", () => {
    log.debug("a", "d");
    log.info("a", "i");
    log.warn("a", "w");
    log.error("a", "e");
    const entries = log.entries();
    expect(entries.map((e) => e.level)).toEqual(["debug", "info", "warn", "error"]);
  });

  it("respects setLevel", () => {
    log.setLevel("warn");
    log.debug("a", "ignored");
    log.info("a", "ignored");
    log.warn("a", "kept");
    log.error("a", "kept");
    expect(log.entries()).toHaveLength(2);
  });

  it("delivers entries to subscribers", () => {
    const got: LogEntry[][] = [];
    const unsub = log.subscribe((e) => got.push(e));
    log.info("x", "y");
    expect(got.at(-1)!.at(-1)!.message).toBe("y");
    unsub();
  });

  it("notify emits a toast and writes a log line with meta", () => {
    const seen: Toast[] = [];
    const unsub = log.subscribeToasts((t) => seen.push(t));
    log.notify("error", "persist", "failed", { foo: 1 });
    expect(seen).toHaveLength(1);
    expect(seen[0].level).toBe("error");
    expect(log.entries().at(-1)!.meta).toEqual({ foo: 1 });
    unsub();
  });

  it("logFailure returns a handler that notifies once", () => {
    const seen: Toast[] = [];
    const unsub = log.subscribeToasts((t) => seen.push(t));
    const handler = logFailure("scope", "label");
    handler(new Error("boom"));
    handler("string-error");
    expect(seen).toHaveLength(2);
    expect(seen[0].message).toMatch(/label: boom/);
    expect(seen[1].message).toMatch(/label: string-error/);
    unsub();
  });

  it("rolls the buffer at the 500-entry cap", () => {
    for (let i = 0; i < 510; i++) log.info("a", String(i));
    const entries = log.entries();
    expect(entries).toHaveLength(500);
    expect(entries[0].message).toBe("10");
    expect(entries.at(-1)!.message).toBe("509");
  });

  it("clear() empties the buffer and notifies subscribers", () => {
    log.info("a", "x");
    let last: LogEntry[] | null = null;
    const unsub = log.subscribe((e) => {
      last = e;
    });
    log.clear();
    expect(last).toEqual([]);
    unsub();
  });
});
