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
