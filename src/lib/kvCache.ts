// KV-cache sizing. The attention cache is the term that actually decides
// whether a given --ctx fits in VRAM, and it is NOT a small constant: a 7B at
// 32k f16 needs ~16 GB of KV on top of its weights. Getting this wrong in the
// understating direction makes long context look free and ends in a silent
// out-of-memory model load, so every input comes from real GGUF metadata and a
// missing term yields null rather than a plausible-looking guess.

/** The subset of `GgufInfo` needed to size a KV cache. All nullable. */
export type KvGeometry = {
  /** Transformer layer count (`{arch}.block_count`). */
  block_count: number | null;
  /** KV heads (`{arch}.attention.head_count_kv`); < head_count under GQA/MQA. */
  head_count_kv: number | null;
  /** Attention heads (`{arch}.attention.head_count`), for the head_dim fallback. */
  head_count: number | null;
  /** Per-head K/V width; absent on most models. */
  key_length: number | null;
  value_length: number | null;
  /** Model width (`{arch}.embedding_length`), for the head_dim fallback. */
  embedding_length: number | null;
};

// Bytes per cached element, per ggml block layout (block = 32 elements):
//   q8_0  32×i8 + f16 d              = 34 B
//   q5_1  16×i4 + 4 B qh + f16 d,m   = 24 B
//   q5_0  16×i4 + 4 B qh + f16 d     = 22 B
//   q4_1  16×i4 + f16 d,m            = 20 B
//   q4_0  16×i4 + f16 d              = 18 B
// These are the `--cache-type-k` / `--cache-type-v` values llama-server takes.
const CACHE_TYPE_BYTES: Record<string, number> = {
  f32: 4,
  f16: 2,
  bf16: 2,
  q8_0: 34 / 32,
  q5_1: 24 / 32,
  q5_0: 22 / 32,
  q4_1: 20 / 32,
  q4_0: 18 / 32,
  iq4_nl: 18 / 32,
};

/** Bytes per cached element for a `--cache-type-*` value; null if unrecognised. */
export function cacheTypeBytes(t: string | null | undefined): number | null {
  if (!t) return null;
  return CACHE_TYPE_BYTES[t.toLowerCase()] ?? null;
}

/**
 * Total KV-cache bytes for `ctx` tokens:
 *
 *   layers × kv_heads × ctx × (k_head_dim × k_bytes + v_head_dim × v_bytes)
 *
 * K and V are separate tensors, so `--cache-type-k` and `--cache-type-v` each
 * size their own half of the sum. head_dim comes from `key_length` /
 * `value_length` when the model declares them, else `embedding_length /
 * head_count`.
 *
 * Returns null when any term is missing or non-positive — the caller is
 * expected to say "unknown", not to substitute a default.
 */
export function kvCacheBytes(
  geo: KvGeometry | null | undefined,
  ctx: number,
  ctk: string,
  ctv: string,
): number | null {
  if (!geo) return null;
  const kBytes = cacheTypeBytes(ctk);
  const vBytes = cacheTypeBytes(ctv);
  const layers = geo.block_count;
  const kvHeads = geo.head_count_kv;

  // Fall back to width / heads only when BOTH are known and head_count is
  // non-zero; a bare embedding_length tells us nothing about per-head width.
  const fallbackDim =
    geo.embedding_length != null && geo.head_count != null && geo.head_count > 0
      ? geo.embedding_length / geo.head_count
      : null;
  const kDim = geo.key_length ?? fallbackDim;
  const vDim = geo.value_length ?? fallbackDim;

  if (
    kBytes == null ||
    vBytes == null ||
    layers == null ||
    kvHeads == null ||
    kDim == null ||
    vDim == null
  ) {
    return null;
  }
  const terms = [ctx, kBytes, vBytes, layers, kvHeads, kDim, vDim];
  if (terms.some((t) => !Number.isFinite(t) || t <= 0)) return null;

  return layers * kvHeads * ctx * (kDim * kBytes + vDim * vBytes);
}

/** Same as `kvCacheBytes`, in GiB. */
export function kvCacheGb(
  geo: KvGeometry | null | undefined,
  ctx: number,
  ctk: string,
  ctv: string,
): number | null {
  const bytes = kvCacheBytes(geo, ctx, ctk, ctv);
  return bytes == null ? null : bytes / 1024 ** 3;
}
