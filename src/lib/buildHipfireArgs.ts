export type HipfireFlagValues = Record<string, string | number | boolean>;

// Build the hipfire `serve` argv list (no "hipfire" prefix). Parallel to
// buildArgs() for llama-server / buildZincArgs() for zinc, but hipfire's CLI
// shape is different from both: it serves a TAG registered ahead of time by
// `hipfire quantize --install --register <tag>` (see hipfireConvert), not a
// raw .gguf path — so unlike llama/zinc there is no model-file argument here.
//
// Documented shape (bench-hipfire-vs-llama.README.md): `hipfire serve <tag>
// <host>:<port>` — tag and host:port are POSITIONAL, not flags. `parse_port`
// (server.rs) reads the port back out of that positional host:port token.
//
// TODO(hipfire-verify): --kv-mode, --idle-timeout, --spec/-md/--draft-max and
// --tp are documented in the integration plan's flag inventory but their
// exact value spellings/ranges are unconfirmed against a live hipfire —
// verify against `hipfire serve --help` once available.
export function buildHipfireArgs(vals: HipfireFlagValues): string[] {
  const out: string[] = [];
  const truthy = (v: unknown) => v !== undefined && v !== null && v !== "";

  const tag = truthy(vals.tag) ? String(vals.tag) : "";
  const host = truthy(vals.host) ? String(vals.host) : "127.0.0.1";
  const port = truthy(vals.port) ? String(vals.port) : "8080";
  out.push("serve", tag, `${host}:${port}`);

  // Only-when-set knobs — hipfire's own defaults apply when omitted.
  if (truthy(vals.kv_mode)) out.push("--kv-mode", String(vals.kv_mode));
  if (truthy(vals.idle_timeout)) out.push("--idle-timeout", String(vals.idle_timeout));
  if (vals.spec) out.push("--spec");
  if (truthy(vals.model_draft)) out.push("-md", String(vals.model_draft));
  if (truthy(vals.draft_max)) out.push("--draft-max", String(vals.draft_max));
  if (truthy(vals.tp)) out.push("--tp", String(vals.tp));
  return out;
}
