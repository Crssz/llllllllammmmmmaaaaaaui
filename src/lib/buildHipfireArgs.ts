export type HipfireFlagValues = Record<string, string | number | boolean>;

// Build the hipfire `serve` argv list (no "hipfire" prefix). Parallel to
// buildArgs() for llama-server / buildZincArgs() for zinc, but hipfire's CLI
// shape is different from both: it serves a TAG registered ahead of time by
// `hipfire quantize --install --register <tag>` or pulled via `hipfire pull
// <tag>` (see hipfireConvert / hipfirePull), not a raw .gguf path — so unlike
// llama/zinc there is no model-file argument here.
//
// VERIFIED live 2026-07-18: `serve [model] [host] [port] [flags]` — the model
// tag positional is OPTIONAL (omitting it pre-warms `cfg.default_model`
// instead of a specific tag). When a tag IS given it's resolved exactly like
// `run`/`pull`, meaning a non-local tag gets auto-pulled from HuggingFace
// before serving — see the "Model tag" picker's hint in Configure. host and
// port may be separate positionals or the combined "host:port" shorthand
// token; the combined form was confirmed live
// (`hipfire serve qwen3.6:27b 127.0.0.1:8080` works), so this app keeps
// emitting it as a single "<host>:<port>" token — `parse_port` (server.rs)
// reads the port back out of that token.
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
  out.push("serve");
  // Omit the model positional entirely when no tag is set, rather than
  // pushing an empty string — `serve` then falls back to cfg.default_model
  // (see above) instead of getting a stray "" positional. Defensive only:
  // the UI's launchPrereqError already requires a tag before Start unlocks.
  if (tag) out.push(tag);
  out.push(`${host}:${port}`);

  // Only-when-set knobs — hipfire's own defaults apply when omitted, EXCEPT
  // --idle-timeout: hipfire's own default (300s = 5 idle minutes) silently
  // unloads the model, which is wrong for a resident desktop chat app that
  // may sit idle between messages and would otherwise pay a full cold reload
  // on the next send. Always emit --idle-timeout: the user's value when set
  // (including an explicit "0"), else "0" (never unload).
  if (truthy(vals.kv_mode)) out.push("--kv-mode", String(vals.kv_mode));
  out.push("--idle-timeout", truthy(vals.idle_timeout) ? String(vals.idle_timeout) : "0");
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

// The inverse of buildHipfireArgs' tag positional: recover the tag a running
// `serve` was actually launched with from serverSlice's `loadedArgs` (the
// exact argv passed to startServer), NOT from the mutable
// `hipfire_flags.tag` next-launch selection — those two can diverge the
// moment the user edits the model picker without reloading, and a
// currently-served-model guard (e.g. blocking `hipfire rm`) must never trust
// the selection over what's actually resident. The tag positional is
// optional and shares its slot with the `host:port` positional (see
// buildHipfireArgs), so counting is the only reliable way to tell them
// apart: every flag buildHipfireArgs can emit (--kv-mode/--idle-timeout/
// --tp) is a "--"-prefixed long option, so the run of positionals ends at
// the first such token (or the end of argv). Two positionals means
// [tag, host:port]; one means [host:port] only (no tag — the daemon
// pre-warmed cfg.default_model instead).
export function hipfireLoadedTag(loadedArgs: string[] | null): string | null {
  if (!loadedArgs || loadedArgs[0] !== "serve") return null;
  const flagIdx = loadedArgs.findIndex((t, i) => i > 0 && t.startsWith("--"));
  const positionals = (flagIdx === -1 ? loadedArgs.length : flagIdx) - 1;
  return positionals === 2 ? loadedArgs[1] : null;
}
