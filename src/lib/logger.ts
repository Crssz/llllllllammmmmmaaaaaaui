// Tiny structured logger with a subscribable ring buffer + console mirror.
// Frontend code calls `log.info("scan", "...")`. UI components subscribe via
// `useLogs()` (see hook below) to render a live panel.

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogEntry = {
  id: number;
  level: LogLevel;
  area: string;
  message: string;
  time: number;
  meta?: unknown;
};

const MAX = 500;
const CONSOLE_PREFIX = "%c[lllammmui]";
const CONSOLE_STYLE_BY_LEVEL: Record<LogLevel, string> = {
  debug: "color:#888",
  info: "color:#9b7bff",
  warn: "color:#e7b15b",
  error: "color:#e57792;font-weight:600",
};
const CONSOLE_FN_BY_LEVEL: Record<LogLevel, (...args: unknown[]) => void> = {
  debug: console.debug,
  info: console.log,
  warn: console.warn,
  error: console.error,
};

export type Toast = {
  id: number;
  level: "warn" | "error";
  area: string;
  message: string;
  time: number;
};

class Logger {
  private buffer: LogEntry[] = [];
  private nextId = 1;
  private readonly subs = new Set<(entries: LogEntry[]) => void>();
  private enabledLevel: LogLevel = "debug";
  private readonly toastSubs = new Set<(toast: Toast) => void>();

  setLevel(level: LogLevel) {
    this.enabledLevel = level;
  }

  subscribe(fn: (entries: LogEntry[]) => void): () => void {
    this.subs.add(fn);
    fn(this.buffer);
    return () => {
      this.subs.delete(fn);
    };
  }

  clear() {
    this.buffer = [];
    this.notifySubs();
  }

  entries(): LogEntry[] {
    return this.buffer;
  }

  // Subscribe to transient toast notifications. Each call to `notify()` fans
  // out to every subscriber once; subscribers are responsible for their own
  // dismissal timing.
  subscribeToasts(fn: (toast: Toast) => void): () => void {
    this.toastSubs.add(fn);
    return () => {
      this.toastSubs.delete(fn);
    };
  }

  // Surface a user-facing notification AND log it. Use this for failures the
  // user needs to see even when the logs panel is closed (persistence errors,
  // server-spawn failures, etc.).
  notify(level: "warn" | "error", area: string, message: string, meta?: unknown) {
    this.write(level, area, message, meta);
    const toast: Toast = {
      id: this.nextId,
      level,
      area,
      message,
      time: Date.now(),
    };
    for (const fn of this.toastSubs) fn(toast);
  }

  private notifySubs() {
    for (const fn of this.subs) fn(this.buffer);
  }

  private rank(level: LogLevel): number {
    return { debug: 0, info: 1, warn: 2, error: 3 }[level];
  }

  private write(level: LogLevel, area: string, message: string, meta?: unknown) {
    if (this.rank(level) < this.rank(this.enabledLevel)) return;

    const entry: LogEntry = {
      id: this.nextId++,
      level,
      area,
      message,
      time: Date.now(),
      meta,
    };
    if (this.buffer.length >= MAX) {
      this.buffer = [...this.buffer.slice(this.buffer.length - MAX + 1), entry];
    } else {
      this.buffer = [...this.buffer, entry];
    }
    this.notifySubs();

    const style = CONSOLE_STYLE_BY_LEVEL[level];
    const fn = CONSOLE_FN_BY_LEVEL[level];
    if (meta === undefined) {
      fn(CONSOLE_PREFIX, style, `[${area}]`, message);
    } else {
      fn(CONSOLE_PREFIX, style, `[${area}]`, message, meta);
    }
  }

  debug(area: string, message: string, meta?: unknown) {
    this.write("debug", area, message, meta);
  }
  info(area: string, message: string, meta?: unknown) {
    this.write("info", area, message, meta);
  }
  warn(area: string, message: string, meta?: unknown) {
    this.write("warn", area, message, meta);
  }
  error(area: string, message: string, meta?: unknown) {
    this.write("error", area, message, meta);
  }
}

export const log = new Logger();

// Rejection handler factory for `.catch(logFailure("persist", "saveChats"))`.
// Routes the error into the structured log AND fires a user-visible toast so
// users notice a failure even when the logs panel is closed.
export function logFailure(area: string, label: string) {
  return (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    log.notify("error", area, `${label}: ${message}`, err);
  };
}

// Surface unhandled errors / rejections.
if (typeof globalThis.window !== "undefined") {
  globalThis.addEventListener("error", (ev) => {
    log.error("window", ev.message || "uncaught error", {
      filename: ev.filename,
      line: ev.lineno,
    });
  });
  globalThis.addEventListener("unhandledrejection", (ev) => {
    log.error("promise", "unhandled rejection", {
      reason: ev.reason instanceof Error ? ev.reason.message : String(ev.reason),
    });
  });
}
