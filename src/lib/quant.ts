// Plain-English descriptions of GGUF quantization tags. Shown as `title`
// tooltips on the colored quant chips at the model-selection decision point
// (Models tab, Catalog, the model-library overlay) so a user picking a file
// isn't choosing on raw jargon like "Q4_K_M" or "IQ2_XS" alone.

// A short size/quality tradeoff phrase per bit-depth. Keyed on the leading
// bit-width parsed out of the tag (Q4_K_M → 4, IQ2_XS → 2, …).
const PHRASE_BY_BITS: Record<number, string> = {
  2: "tiny file, noticeable quality loss",
  3: "very small, some quality loss",
  4: "small & fast, slight quality loss",
  5: "balanced size & quality",
  6: "large, high quality",
  8: "near-lossless, large",
};

/**
 * Map a quant tag to a one-line human description with its size/quality
 * tradeoff. Handles the common quant families (Q2..Q8 and their K variants),
 * importance-matrix IQ quants, and the full/half-precision float formats,
 * falling back to a generic label for anything unrecognized.
 */
export function quantDescription(tag: string): string {
  const raw = (tag ?? "").trim();
  if (!raw) return "Quantization level";
  const t = raw.toUpperCase();

  // Full- and half-precision floats (not quantized, but shown in the same chip).
  if (t === "F32" || t === "FP32")
    return `${raw} — 32-bit float: full precision, largest & slowest`;
  if (t === "F16" || t === "FP16") return `${raw} — 16-bit float: full quality, large file`;
  if (t === "BF16") return `${raw} — 16-bit brain float: full quality, large file`;

  // Integer quants: leading Q<n> or IQ<n> carries the bit width.
  const m = /^I?Q(\d+)/.exec(t);
  if (m) {
    const bits = Number(m[1]);
    const iq = t.startsWith("IQ") ? " (IQ, importance-weighted)" : "";
    const phrase = PHRASE_BY_BITS[bits] ?? `${bits}-bit quantization`;
    return `${raw} — ${bits}-bit${iq}: ${phrase}`;
  }

  return `${raw} — quantized weights`;
}
