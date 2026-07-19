import { vi } from "vitest";

// Stub Tauri modules so importing `src/lib/api.ts` works in node tests.
// Individual test files override `api.*` methods via vi.spyOn for behavior.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => null),
}));

// hipfire chat routes through this plugin's fetch instead of the global one
// (see chatSlice.ts runChatRound) — stub it so tests run without Tauri.
// Individual suites override the implementation via vi.spyOn/vi.mocked.
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: vi.fn(async () => new Response(null, { status: 200 })),
}));
