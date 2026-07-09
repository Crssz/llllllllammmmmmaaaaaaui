// @vitest-environment jsdom
//
// Smoke-render every screen once against the real Zustand store in its
// initial state. Tauri calls resolve via the node-environment mocks in
// src/test/setup.ts (invoke/listen/dialog all no-op), and stubApi() gives
// every api.* method a well-shaped resolved value so mount-time effects
// (e.g. McpScreen's mcpRefreshStatus, EngineManagerScreen's
// fetchEngineReleases) don't reject against real network/IPC calls. The only
// assertion is "it renders without throwing" — this exists to catch
// import-time or render-time crashes, not to verify behavior.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { freshStore, stubApi } from "../state/testUtils";
import { api } from "../lib/api";

import { BenchScreen } from "./Bench";
import { BinaryLocator } from "./BinaryLocator";
import { CatalogScreen } from "./Catalog";
import { ChatScreen } from "./Chat";
import { ConfigureScreen } from "./Configure";
import { EngineManagerScreen } from "./EngineManager";
import { HardwareScreen } from "./Hardware";
import { McpScreen } from "./Mcp";
import { ModelsScreen } from "./Models";
import { ProfilesScreen } from "./Profiles";
import { TranscribeScreen } from "./Transcribe";

// jsdom (unlike a real browser) doesn't implement requestAnimationFrame, but
// ChatScreen's auto-scroll effect calls it on every mount. Stub with a
// same-tick fallback so the effect body runs without throwing.
if (typeof globalThis.requestAnimationFrame !== "function") {
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    globalThis.setTimeout(() => cb(Date.now()), 0)) as typeof requestAnimationFrame;
}
if (typeof globalThis.cancelAnimationFrame !== "function") {
  globalThis.cancelAnimationFrame = ((id: number) =>
    globalThis.clearTimeout(id)) as typeof cancelAnimationFrame;
}

// jsdom doesn't implement the native <dialog> element's modal methods.
// ChatDialogs (rendered inside ChatScreen) only calls these when a pending
// approval/choice exists, which is never true for a freshly-reset store —
// but stub them defensively so the smoke test doesn't depend on that timing.
if (typeof HTMLDialogElement.prototype.showModal !== "function") {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
}
if (typeof HTMLDialogElement.prototype.close !== "function") {
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
}

// jsdom has no URL.createObjectURL/revokeObjectURL. Transcribe's recording
// flow calls createObjectURL, and its cleanup effect calls revokeObjectURL;
// neither fires on a plain mount, but stub them so any future effect timing
// change fails on a real assertion instead of a ReferenceError.
if (typeof URL.createObjectURL !== "function") {
  URL.createObjectURL = () => "blob:stub";
}
if (typeof URL.revokeObjectURL !== "function") {
  URL.revokeObjectURL = () => {};
}

beforeEach(() => {
  freshStore();
  stubApi();
  // stubApi() doesn't cover the engine-manager endpoints (no engineSlice
  // test exists yet to have needed them). Without a stub, the raw
  // invoke-resolves-undefined mock from src/test/setup.ts flows into
  // refreshInstalledEngines' unconditional `set({ installedEngines: installed })`,
  // leaving installedEngines as undefined and crashing EngineManagerScreen's
  // `for (const e of installedEngines)`.
  vi.spyOn(api, "listInstalledEngines").mockResolvedValue([]);
  vi.spyOn(api, "listEngineReleases").mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
});

async function renderScreen(ui: React.ReactElement) {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(ui);
  });
  return result;
}

describe("screen smoke render", () => {
  it("renders BenchScreen", async () => {
    const { container } = await renderScreen(<BenchScreen />);
    expect(container.firstChild).not.toBeNull();
  });

  it("renders BinaryLocator", async () => {
    const { container } = await renderScreen(<BinaryLocator />);
    expect(container.firstChild).not.toBeNull();
  });

  it("renders CatalogScreen", async () => {
    const { container } = await renderScreen(<CatalogScreen />);
    expect(container.firstChild).not.toBeNull();
  });

  it("renders ChatScreen", async () => {
    const { container } = await renderScreen(<ChatScreen />);
    expect(container.firstChild).not.toBeNull();
  });

  it("renders ConfigureScreen", async () => {
    const { container } = await renderScreen(<ConfigureScreen />);
    expect(container.firstChild).not.toBeNull();
  });

  it("renders EngineManagerScreen", async () => {
    const { container } = await renderScreen(<EngineManagerScreen />);
    expect(container.firstChild).not.toBeNull();
  });

  it("renders HardwareScreen", async () => {
    const { container } = await renderScreen(<HardwareScreen />);
    expect(container.firstChild).not.toBeNull();
  });

  it("renders McpScreen", async () => {
    const { container } = await renderScreen(<McpScreen />);
    expect(container.firstChild).not.toBeNull();
  });

  it("renders ModelsScreen", async () => {
    const { container } = await renderScreen(<ModelsScreen />);
    expect(container.firstChild).not.toBeNull();
  });

  it("renders ProfilesScreen", async () => {
    const { container } = await renderScreen(<ProfilesScreen />);
    expect(container.firstChild).not.toBeNull();
  });

  it("renders TranscribeScreen", async () => {
    const { container } = await renderScreen(<TranscribeScreen />);
    expect(container.firstChild).not.toBeNull();
  });
});
