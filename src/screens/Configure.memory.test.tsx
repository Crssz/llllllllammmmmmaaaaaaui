// @vitest-environment jsdom
//
// The "Estimated memory" panel's KV row, end to end: GGUF metadata → store →
// rendered GB. Guards the regression this panel shipped with, where the KV
// term used a literal 64 in place of layers × kv_heads × head_dim and
// understated a 7B at 32k by ~1000× — the number users size their context off.
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { freshStore, stubApi, useAppStore } from "../state/testUtils";
import { defaultFlags } from "../data";
import type { GgufInfo } from "../lib/api";
import { ConfigureScreen } from "./Configure";

// Llama-2-7B geometry: 32 layers, 32 heads, 32 KV heads (MHA), width 4096 →
// head_dim 128. No explicit key/value_length, so the emb/heads fallback runs.
const llama2_7b: GgufInfo = {
  path: "/m/llama-2-7b.Q4_K_M.gguf",
  gguf_version: 3,
  tensor_count: 291,
  metadata_count: 20,
  architecture: "llama",
  general_name: "llama-2-7b",
  context_length: 4096,
  block_count: 32,
  head_count_kv: 32,
  head_count: 32,
  key_length: null,
  value_length: null,
  embedding_length: 4096,
  mtp_support: false,
  size_gb: 4,
  mmproj_siblings: [],
  supports_thinking: false,
  thinking_style: null,
  tensor_types: ["Q4_K"],
};

async function renderAt(ctx: number, info: GgufInfo | null) {
  useAppStore.getState().resetFlags({ ...defaultFlags, ctx, ctk: "f16", ctv: "f16" });
  useAppStore.getState().setModelInfo(info, null);
  let container!: HTMLElement;
  await act(async () => {
    container = render(<ConfigureScreen />).container;
  });
  return container.textContent ?? "";
}

beforeEach(() => {
  freshStore();
  stubApi();
});

afterEach(() => {
  cleanup();
});

describe("Configure — estimated memory", () => {
  it("sizes the KV cache from real GGUF geometry (7B @ 32k f16 ≈ 16 GB)", async () => {
    const text = await renderAt(32768, llama2_7b);
    expect(text).toContain("16.00 GB");
    // 4 GB weights + 16 GB KV + 0.6 GB overhead, and no "excl. KV" caveat.
    expect(text).toContain("20.60 GB");
    expect(text).not.toContain("excl. KV");
    expect(text).not.toContain("needs model metadata");
  });

  it("is 4x smaller for a GQA model with 4x fewer KV heads", async () => {
    const text = await renderAt(32768, { ...llama2_7b, head_count_kv: 8 });
    expect(text).toContain("4.00 GB");
  });

  it("says so instead of guessing when the geometry is missing", async () => {
    const text = await renderAt(32768, { ...llama2_7b, head_count_kv: null });
    expect(text).toContain("needs model metadata");
    // Total drops the KV term AND admits it, rather than quietly under-reporting.
    expect(text).toContain("est. · excl. KV");
    expect(text).toContain("4.60 GB");
  });

  it("shows no KV estimate before a model is selected", async () => {
    const text = await renderAt(32768, null);
    expect(text).toContain("needs model metadata");
    expect(text).toContain("select a model");
  });
});
