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
// VERIFIED live against `hipfire serve --help`: serve accepts only
// -d/--detach, --kv-mode, --idle-timeout, --no-prewarm, --tp. --kv-mode,
// --idle-timeout, and --tp below are confirmed correct as serve flags.
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
  if (truthy(vals.tp)) out.push("--tp", String(vals.tp));

  // VERIFIED: --spec, -md/--model-draft, and --draft-max/--draft are
  // `hipfire run`-only flags. `hipfire serve --help` does not list them, and
  // passing any of them to `serve` makes the daemon fail to start. The serve
  // daemon configures speculative decoding through config keys instead
  // (`hipfire config list` shows speculation=auto, dflash_mode=auto,
  // mtp_mode, ngram_mode, ...) — with dflash_mode=auto and a draft model
  // present, DFlash engages automatically (confirmed live: a streamed
  // completion returned timings:{...,"dflash":true} with no serve flags at
  // all). Per-daemon speculation control, if ever wanted, must be done via
  // `hipfire config set speculation|dflash_mode ...` BEFORE serving — a
  // future enhancement, not serve argv — so none of those flags are emitted
  // here.
  return out;
}
