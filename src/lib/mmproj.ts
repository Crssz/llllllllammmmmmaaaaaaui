// Multi-modal projector (--mmproj) auto-detection.
//
// llama.cpp vision models need a companion `mmproj-*.gguf` projector. When the
// projector sits next to the model on disk, the backend reports it as a
// "sibling" (see inspect_gguf in gguf.rs) and we auto-fill the flag so vision
// models Just Work. This is the pure decision the inspect effect applies — the
// effect itself only handles store wiring and the per-model "pinned" guard that
// lets a user override or clear mmproj deliberately.

export type MmprojDecision = { type: "set"; value: string } | { type: "clear" } | { type: "none" };

/**
 * Decide how to auto-manage `mmproj` for a freshly-inspected model.
 *
 * `current` is the model's current mmproj flag ("" when unset); `siblings` are
 * the projector GGUFs found in the model's own folder. The caller is
 * responsible for skipping this entirely when the user has pinned mmproj for
 * the model — this function only encodes the auto-detect heuristic:
 *
 *  - a sibling exists and the current value isn't one of them → adopt it
 *    (fills an empty value, and re-points a stale path to the real sibling);
 *  - no sibling exists but a value is set → clear the stale/carried-over path;
 *  - otherwise leave it alone.
 */
export function resolveMmproj(current: string, siblings: readonly string[]): MmprojDecision {
  const sibling = siblings[0];
  const currentIsValid = current !== "" && siblings.includes(current);
  if (sibling && !currentIsValid) return { type: "set", value: sibling };
  if (!sibling && current !== "") return { type: "clear" };
  return { type: "none" };
}
