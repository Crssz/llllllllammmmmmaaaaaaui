import { describe, it, expect } from "vitest";
import { cacheTypeBytes, kvCacheBytes, kvCacheGb, type KvGeometry } from "./kvCache";

const GB = 1024 ** 3;

// Llama-2-7B: 32 layers, 32 heads, 32 KV heads (MHA), width 4096 → head_dim
// 4096/32 = 128. No explicit key/value_length, so the fallback is exercised.
const llama2_7b: KvGeometry = {
  block_count: 32,
  head_count_kv: 32,
  head_count: 32,
  key_length: null,
  value_length: null,
  embedding_length: 4096,
};

// Same model with GQA (8 KV heads instead of 32) — 4× less KV.
const gqa: KvGeometry = { ...llama2_7b, head_count_kv: 8 };

describe("cacheTypeBytes", () => {
  it("maps the cache dtypes llama-server accepts", () => {
    expect(cacheTypeBytes("f32")).toBe(4);
    expect(cacheTypeBytes("f16")).toBe(2);
    expect(cacheTypeBytes("q8_0")).toBeCloseTo(1.0625, 6);
    expect(cacheTypeBytes("q4_0")).toBeCloseTo(0.5625, 6);
    expect(cacheTypeBytes("F16")).toBe(2);
  });

  it("returns null for unknown or empty types", () => {
    expect(cacheTypeBytes("q3_k")).toBeNull();
    expect(cacheTypeBytes("")).toBeNull();
    expect(cacheTypeBytes(null)).toBeNull();
  });
});

describe("kvCacheBytes", () => {
  it("matches the known Llama-2-7B figure: 32k f16 ≈ 16 GB", () => {
    // 32 layers × 32 kv heads × 128 head_dim × 32768 ctx × (2 + 2) B = 16 GiB.
    expect(kvCacheBytes(llama2_7b, 32768, "f16", "f16")).toBe(16 * GB);
    expect(kvCacheGb(llama2_7b, 32768, "f16", "f16")).toBe(16);
  });

  it("scales linearly with context", () => {
    expect(kvCacheGb(llama2_7b, 8192, "f16", "f16")).toBe(4);
    expect(kvCacheGb(llama2_7b, 131072, "f16", "f16")).toBe(64);
  });

  it("is 4x smaller for a GQA model with 4x fewer KV heads", () => {
    expect(kvCacheGb(gqa, 32768, "f16", "f16")).toBe(4);
  });

  it("sizes K and V independently from their own cache dtypes", () => {
    const f16 = kvCacheBytes(llama2_7b, 32768, "f16", "f16") ?? 0;
    // f32 keys + f16 values = 1.5× the all-f16 cost, not 2× and not 1×.
    expect(kvCacheBytes(llama2_7b, 32768, "f32", "f16")).toBe(f16 * 1.5);
    expect(kvCacheBytes(llama2_7b, 32768, "f16", "f32")).toBe(f16 * 1.5);
    // Quantising only the keys shaves just the K half.
    const q8 = kvCacheBytes(llama2_7b, 32768, "q8_0", "f16") ?? 0;
    expect(q8 / f16).toBeCloseTo((1.0625 + 2) / 4, 6);
  });

  it("prefers explicit key_length/value_length over the fallback", () => {
    // Declared 256-wide heads: double the 4096/32 = 128 fallback.
    const wide: KvGeometry = { ...llama2_7b, key_length: 256, value_length: 256 };
    expect(kvCacheGb(wide, 32768, "f16", "f16")).toBe(32);
  });

  it("returns null when any geometry term is missing", () => {
    expect(kvCacheBytes(null, 32768, "f16", "f16")).toBeNull();
    expect(kvCacheBytes({ ...llama2_7b, block_count: null }, 32768, "f16", "f16")).toBeNull();
    expect(kvCacheBytes({ ...llama2_7b, head_count_kv: null }, 32768, "f16", "f16")).toBeNull();
    // No key_length AND no usable fallback (head_count missing).
    expect(kvCacheBytes({ ...llama2_7b, head_count: null }, 32768, "f16", "f16")).toBeNull();
    expect(kvCacheBytes({ ...llama2_7b, embedding_length: null }, 32768, "f16", "f16")).toBeNull();
  });

  it("returns null for an unusable ctx, dtype, or zero-valued term", () => {
    expect(kvCacheBytes(llama2_7b, 0, "f16", "f16")).toBeNull();
    expect(kvCacheBytes(llama2_7b, Number.NaN, "f16", "f16")).toBeNull();
    expect(kvCacheBytes(llama2_7b, 32768, "wat", "f16")).toBeNull();
    expect(kvCacheBytes({ ...llama2_7b, head_count: 0 }, 32768, "f16", "f16")).toBeNull();
  });
});
