# hipfire live-verification checklist

Run this ONCE, on the machine with hipfire installed and serving on the R9700. It resolves
every `// TODO(hipfire-verify)` the integration left as a documented assumption. Each item:
the **assumption** baked into the code (with file to edit), **how to verify** it against a
live hipfire, and **what to change if it's wrong**.

Branch: `hipfire-integration`. Prereq: hipfire built + a model converted + `hipfire serve
<tag> 127.0.0.1:11435 -d` running (see `bench-hipfire-vs-llama.README.md` for setup).

Quick capture of a raw stream for the dialect checks (§3):
```powershell
$body = '{"model":"<TAG>","stream":true,"messages":[{"role":"user","content":"count to five"}],"max_tokens":64}'
curl.exe -N -s -X POST http://127.0.0.1:11435/v1/chat/completions -H "Content-Type: application/json" -d $body
```

---

## ✅ Live verification results (2026-07-14, R9700 gfx1201, HIP 7.13, hipfire on qwen3.6:27b)

Ran against a live `hipfire serve`. Outcome:

- **Environment OK:** GPU gfx1201, 34.2 GB VRAM, precompiled kernels present (`gfx1201: 48 blobs`), WMMA yes, no hipcc needed at runtime. `qwen3.6:27b` + its DFlash draft loaded and served.
- **BUG → fix 1:** spec flags (`--spec`/`-md`/`--draft-max`) are **`run`-only, rejected by `serve`**; the daemon uses config keys (`speculation`/`dflash_mode`=auto). `buildHipfireArgs` was emitting them on serve → removed. DFlash auto-engages via config (verified `timings.dflash=true`).
- **BUG → fix 2:** streamed responses **DO** include a final `usage` frame (`completion_tokens`) + native `timings` (`decode_tok_s`). The `allowEstimate` chunk-count path for hipfire was unnecessary → switched to exact usage.
- **Confirmed correct as coded:** model id must be the tag (`"local"` → HTTP 404); `reasoning_content` is the field name (stream + non-stream); tools stay gated off (hipfire returns a raw `<tool_call>` text token, no structured `tool_calls`); `/health` = 200 when ready; `--kv-mode` values `auto|q8|asym4|asym3|asym2|fwht4|fwht3|fwht2|turbo`; quantize flags (`--format/--install/--register`) as assumed.
- **Still unverified (left as TODO):** image/audio media (no VL model local — kept gated off, text-only); exact `/health` behavior *during* model load (masked by serve's ready-wait; low risk — requests queue until loaded); `enable_thinking:false` in the request was **ignored** (thinking is config-driven `thinking on/off`, not request-controllable — we send no toggle, so consistent).

The two fixes are being applied on `hipfire-integration`. Remaining boxes below are the still-open / re-runnable items.

---

## 1. Startup: port + health

- [ ] **Port is read correctly.** Assumption: `parse_port` picks up hipfire's positional
      `127.0.0.1:<port>` (server.rs). Verify: start via the app under the hipfire toggle,
      then confirm the health probe targets the same port hipfire bound. If the app reports
      "not ready" forever while `hipfire ps` shows it serving, the port parse is off.
      Fix: `src-tauri/src/server.rs` `parse_port`.

- [ ] **`/health` readiness semantics.** Assumption (server.rs `probe_health`): any HTTP 200
      = ready. **Risk to check explicitly:** hit `GET /health` *during model load* (right
      after `serve` starts, before the first prewarm finishes). The research found hipfire's
      `/health` returns **200 unconditionally**, even while loading — if so, the app flips
      `ready=true` too early and the first chat request races the model load.
      Verify: `curl http://127.0.0.1:11435/health` immediately after start vs after warm.
      Fix if it 200s-while-loading: gate readiness on `/stats` (has `model`/`queue_depth`)
      or on a trial `/v1/chat/completions`, in `probe_health` — currently a plain 200 check.

## 2. CLI flag spellings (buildHipfireArgs.ts:13, data.ts:751/778)

- [ ] **⚠ Highest-priority: are spec flags even valid on `serve`?** Assumption:
      `buildHipfireArgs` emits `--spec` / `-md` / `--draft-max` on the `hipfire serve`
      command. But the docs put those on `hipfire **run**`; the *serve daemon* configures
      speculation through **config keys** (`speculation`, `dflash_mode`, `mtp_mode`) instead.
      If serve rejects `--spec`, the server won't start under any spec setting.
      Verify: `hipfire serve --help` and check whether `--spec`/`-md`/`--draft-max` appear.
      Fix if absent: drop them from the serve argv in `src/lib/buildHipfireArgs.ts` and set
      speculation via `hipfire config set` (a new step in `hipfire_convert.rs` or a
      pre-serve call), or move them only where `run` is used.

- [ ] **`--kv-mode` accepted values** (data.ts:751). Verify against `hipfire serve --help`:
      expected `q8, asym4, asym3, asym2, fwht4, fwht3, fwht2, auto`. Fix: the option list in
      `src/data.ts` `HIPFIRE_FLAG_GROUPS`.

- [ ] **`--spec` is a valued flag, not a bare toggle** (data.ts:778): takes
      `off|auto|ngram|dflash|mtp|dspark`. Confirm the flag type in `data.ts` matches.

- [ ] **`--idle-timeout <s>` and `--tp N`** spellings/ranges match `hipfire serve --help`.

## 3. Chat dialect (chatHelpers.ts:162/166, chatSlice.ts:222/365/496)

- [ ] **`model` field.** Assumption: hipfire accepts the loaded **tag** as `model` (not
      `"local"`). Verify: the capture above with `"model":"<TAG>"` returns 200 and streams.
      Also try `"model":"local"` — if it 404s, the tag is mandatory (assumption correct). If
      both work, no change. Fix location: `shapeChatBody` in `src/lib/chatHelpers.ts`.

- [ ] **Final `usage` frame.** Assumption: hipfire emits **no** usage frame, so token/s is a
      chunk-count estimate (`finalizeTokenStats` `allowEstimate` for hipfire). Verify: in the
      raw stream, look for a final `data:` frame containing `"usage":{"completion_tokens":…}`.
      If present: switch hipfire to exact counts and turn `allowEstimate` off — the estimate
      is a fallback we no longer need. Fix: `finalizeTokenStats` + its caller in `chatSlice.ts`.

- [ ] **Reasoning field.** Assumption: reasoning streams as `delta.reasoning_content`
      (chatSlice.ts:365, parsing is engine-agnostic). Verify: with a thinking model, confirm
      the field name in the stream. If different, add a hipfire branch in the SSE parse.

- [ ] **Tools.** Assumption: hipfire does NOT support `tools`/`delta.tool_calls`, so tools
      are gated off (chatHelpers.ts:162). Verify: send a request with a `tools` array; see if
      it accepts and streams `tool_calls`. If it works, un-gate tools for hipfire.

- [ ] **Media.** Assumption: text-only — `image_url`/`input_audio` parts are dropped
      (chatSlice.ts:222/496, transcribeSlice.ts:49). Verify: send an `image_url` content part
      to a VL tag (e.g. dots.ocr / Qwen3.5-VL). If accepted, un-gate media + transcribe for
      hipfire. **Also confirm** the drop leaves non-empty content (no 400 / poisoned history)
      — send an image-only message under hipfire and check it doesn't error the stream.

## 4. Conversion pipeline (hipfire_convert.rs)

- [ ] **Convert works and progress parses.** Assumption: `hipfire quantize <gguf>
      --format hf4 --install --register <tag>` runs and its stdout matches what
      `hipfire_convert.rs` parses into `hipfire-convert-progress` events. Verify: run a real
      conversion of a small GGUF through the Configure panel; confirm the progress bar moves
      and `hipfire-convert-done` fires. If the parse is off, the bar won't move even though
      the child succeeds. Fix: the stdout parsing in `src-tauri/src/hipfire_convert.rs`.

- [ ] **Tensor-type pre-check.** Assumption: unsupported source quants (IQ*, Q5_0/Q5_1,
      Q2_K/Q3_K) are refused before spawning. Verify: point it at an IQ4 GGUF; expect a clean
      refusal, not a child panic. (Note: Q5_K **is** supported by hipfire's quantizer despite
      stale docs — make sure the pre-check doesn't wrongly reject Q5_K.)

- [ ] **Registered tag loads.** After convert, `hipfire run <tag>` / serving that tag works.

## 5. End-to-end + engine-switch smoke

- [ ] **Full hipfire round-trip:** toggle to hipfire in Configure → set exe path → convert a
      small model → Start → health goes ready → send a chat → tokens stream → token stats
      populate → Stop.
- [ ] **llama still works:** toggle back to llama, Start, send a chat — behavior unchanged.
- [ ] **Engine switch without restart:** with llama-server running, flip the toggle to
      hipfire. Confirm the running llama-server is NOT torn down until you explicitly
      Start/Reload, and that a Reload validates the hipfire prereqs (exe + model) *before*
      stopping llama. (This is the failure class the prereq-before-teardown fix targets.)
- [ ] **Profiles/per-model:** save a hipfire profile, switch away, re-apply — engine axis and
      hipfire flags restore; a llama profile still restores llama flags.

---

When every box is checked, delete the corresponding `// TODO(hipfire-verify)` comments (grep:
`git grep -n "TODO(hipfire-verify)"`) and note any code fixes in a follow-up commit.

---

## 2026-07-18 model-loading re-verification

hipfire's CLI changed model-loading behavior since the 2026-07-14 pass above. Ran read-only
`hipfire list` / `hipfire list -r` / `hipfire help` / `hipfire serve --help` against the live
install at `~/.hipfire/bin/hipfire.cmd` (no `serve`/`stop`/`pull` executed, no processes killed).
Results, and the code that changed in response:

1. **`serve` usage is now `hipfire serve [model] [host] [port] [flags]`.** `[model]` is
   OPTIONAL — omitting it pre-warms `cfg.default_model` instead. It's resolved exactly like
   `run`/`pull`, so **a non-local tag is auto-pulled from HuggingFace** before serving. `host`
   and `port` may be separate positionals or the combined `"host:port"` shorthand — the combined
   form was confirmed live (`hipfire serve qwen3.6:27b 127.0.0.1:8080` works), so lm-st's
   existing argv shape needed no change there. Flags: `-d/--detach`, `--kv-mode <m>`,
   `--idle-timeout <s>` (0 = never, max 86400), `--no-prewarm`, `--tp N`.
   → **D**: `src/lib/buildHipfireArgs.ts` header comment refreshed; the tag positional is now
   omitted entirely (not pushed as `""`) when unset, so an empty tag correctly falls through to
   `serve`'s own default-model resolution instead of sending a stray empty positional.

2. **`GET /health` returns 200 immediately once the daemon binds the port — BEFORE the model
   finishes loading.** Exact captured bodies:
   `{"status":"ok","model":null,"idle_timeout_sec":300,"pid":42784,"token":"42784-mrql36h5-mz74d1dt"}`
   while loading/idle, and the same shape with `"model"` set to the **full file path** (e.g.
   `"C:\Users\pay20\.hipfire\models\qwen3.6-27b.mq4"`, not the tag) once resident. So a bare 200
   no longer means "ready" for hipfire — the daemon binds the port first and prewarms in the
   background.
   → **B**: `probe_health` (server.rs) now reads the full response into a bounded buffer
   (instead of the first 64 bytes) and hands it to `health_response_indicates_ready`, which
   still requires a 200 status line (so llama-server's 503-while-loading is unchanged), then
   parses the JSON body: an object with `"model": null` → not ready; no `"model"` key at all
   (llama-server's shape) or an empty/unparseable body → ready, same as before. Unit-tested
   against the verbatim `model:null` body above, a `model:"<path>"` body, a plain llama body,
   and an empty body.

3. **`GET /v1/models` exists**: `{"data":[{"id":"qwen3.6-27b.mq4"},{"id":"qwen36-27b-dflash-mq4.hfq"}]}`
   — ids are file stems, not tags. Chat requests still take the TAG in the `model` field
   (unchanged from the 2026-07-14 pass). No code change; noted for a future model-id-mapping
   feature if one is ever needed.

4. **`hipfire config list` defaults**: `idle_timeout=300` — the model auto-**unloads** after 5
   idle minutes, and the next request then pays a full cold reload. Wrong default for a
   resident desktop chat app. `default_model=qwen3.6:27b`, `host=0.0.0.0`, `port=11435`.
   → **D**: `buildHipfireArgs` now always emits `--idle-timeout` — the user's configured value
   when set (including an explicit `"0"`), else `"0"` (never unload) — instead of omitting the
   flag and falling through to hipfire's 300s default. `data.ts`'s `idle_timeout` flag
   description updated to say so explicitly.

5. **`hipfire list` output** (parser fixture — two-space indent, FILE, whitespace, SIZE,
   whitespace, `(TAG)`):
   ```
   Local models:

     qwen3.6-27b.mq4                     15.0GB (qwen3.6:27b)
     qwen36-27b-dflash-mq4.hfq            0.9GB (qwen3.6:27b-draft)
   ```
   → **A**: new `list_hipfire_models` Tauri command (server.rs, next to `resolve_hipfire_bin`)
   runs `<bin> list` and parses only the "Local models:" section via the pure, unit-tested
   `parse_hipfire_list` (fixture above + an empty-output case + a combined `list -r` case).
   Feeds a picker (`HipfireModelPicker`, Configure.tsx) for the "Model tag" field, alongside the
   existing free-text input.

6. **`hipfire list -r` output** adds an "Available models:" section (curated pull catalog,
   50+ entries) — TAG, SIZE, then a free-text NOTE (may be many words, unicode, and end with a
   `[downloaded]` marker for tags already present locally). Representative lines used as the
   parser fixture (multi-word note, unicode, both `[downloaded]` forms):
   ```
   Available models:

     qwen3.5:0.8b            0.55GB  386 / 5100 tok/s
     deepseek-v4-flash         82GB  DeepSeek V4 Flash, MQ2-Lloyd routed-expert MoE (arch_id=9). Includes MTP sidecar for K=2 spec-decode (+29% TG on code). temp=1.0 is safety-critical: greedy/low-temp falls into token loops on the quant.
     qwen3.6:27b               15GB  44 tok/s AR / 185 tok/s w/ draft on code [downloaded]
     qwen3.6:27b-draft       0.92GB  DFlash draft for qwen3.6:27b - pairs with target for ~4x decode on code (refreshed 2026-04-27 from z-lab@0919688) [downloaded]
   ```
   → **F**: new `hipfire_pull.rs` module (mirrors `hipfire_convert.rs`'s process-orchestration
   and event-streaming pattern) adds `list_hipfire_available` (pure, unit-tested
   `parse_hipfire_available` against the fixture above, including the long deepseek note and
   both `[downloaded]` lines) and `hipfire_pull`/`cancel_hipfire_pull`, streaming raw
   stdout/stderr lines via `hipfire-pull-progress` / `hipfire-pull-done` events. Frontend:
   `HipfirePullPanel` (Configure.tsx) — catalog dropdown, Pull button, streaming log, error
   surface; refreshes the local-model picker (item 5) on success. User-click only, never
   auto-started.

7. **`hipfire stop` is effectively broken on Windows**, even against its own freshly-written,
   correct pidfile: `"Not killing PID X: no port / token / (cmdline+startTime) confirmation -
   refusing to kill (possible reused pid) - removing stale pidfile"` (the confirmation needs
   `lsof`/`ss`, unavailable on Windows). `hipfire stop --force` prints `"win32: orphan reap is
   Linux-only; the port was NOT freed"`. lm-st never shells out to `hipfire stop` (it manages
   the child process handle directly), so this doesn't block anything, but it rules out
   `hipfire stop` as a cleanup fallback — see item 8's fix instead.

8. **Orphan proven live**: spawning `hipfire.cmd` creates the tree `cmd.exe -> (conhost.exe +
   bun.exe)`, where `bun.exe` IS the serving daemon (there is no `daemon.exe`). Killing the top
   `cmd.exe` process — exactly what `Child::kill()` does — leaves `bun.exe` running, still
   holding the model's VRAM and the port.
   → **C**: `ServerState` gained a `tree_kill: AtomicBool`, set at spawn time from the same
   `exe_path.is_some()` discriminator `start_server` already uses to pick the hipfire vs. llama
   spawn path. Every hipfire-child kill site (`stop_server`, the stale-child kill at the top of
   `start_server`, the window-destroy cleanup for `ServerState`/`HipfireConvertState`/
   `HipfirePullState`, and `cancel_hipfire_convert`/`cancel_hipfire_pull`) now goes through the
   new `kill_child_tree` helper (server.rs), which shells out to `taskkill /F /T /PID <pid>` on
   Windows when the tree-kill flag is set, falling back to a plain `child.kill()` when it's
   unset, `taskkill` itself fails, or the platform isn't Windows (on Unix the hipfire child IS
   `bun` directly — no intermediate shell wrapper). The llama path (`tree_kill` unset) issues
   the exact same `child.kill()` as before at every site; `kill_child_tree` also always
   `child.wait()`s afterwards to reap, per its spec — that was already true of `stop_server`,
   and is now also true of the window-destroy cleanup and the (practically unreachable)
   stale-child guard in `start_server`, which previously fired-and-forgot the kill. No change to
   argv, env, spawn, or probe semantics for llama either way.

---

## 2026-07-19 tools probe + unified chat UX

**Tools probe** (live, `qwen3.6:27b` served via hipfire). Sent a standard OpenAI-shaped
`POST /v1/chat/completions` with a `tools` array attached, once non-streamed and once
streamed:

- **Accepted and templated.** hipfire did not reject the request — `prompt_tokens` grew
  versus the same turn without `tools`, and `reasoning_content` showed the model visibly
  deciding whether to call the tool. So the chat template *does* render the tool schema into
  the prompt when `tools` is present.
- **Force-EOS at `<tool_call>`, both modes.** Non-streamed: the response's `content` was the
  literal string `"<tool_call>"` with `finish_reason:"stop"` — generation was cut the instant
  the model started emitting a tool call, before any arguments or the closing tag. Streamed:
  identical — a single `delta:{"content":"<tool_call>\n"}` chunk, then `finish_reason:"stop"`
  immediately.
- **No structured `tool_calls` field ever appeared**, in either mode. There is no parseable
  JSON tool call to extract — just a truncated text fragment.
- **Conclusion: tool calls are broken upstream in the hipfire daemon itself**, not a request-
  shaping gap on lm-st's side. `shapeChatBody`'s existing behavior — stripping `tools` entirely
  for hipfire (`src/lib/chatHelpers.ts`) — was already correct and stays unchanged. The fix
  this pass makes is UI surfacing (below), not request shaping.

**Unified chat UX** (this pass, `hipfire-integration`). The reported bug: with
`engine_kind=hipfire` and hipfire serving fine, Chat's send gate
(`server.ready && !!flags.model`) was permanently false — `flags.model` is llama's GGUF-path
flag, and hipfire never sets it (its identity is `settings.hipfire_flags.tag`). Fixed by
introducing a shared engine dispatch for "what model is active", mirroring the existing
`activeEngine` selector:

- **A — `activeModelLabel` selector + Chat send gate.** New export next to `activeEngine` in
  `src/state/slices/serverSlice.ts`: resolves to the non-empty `hipfire_flags.tag` for hipfire,
  or the full `flags.model` path for llama (callers basename it), `null` if unset. `activeEngine`
  itself already does the "running server wins over the toggle" dispatch, so this inherits it
  for free. `Chat.tsx`'s `canSend`, model badge, and context-estimate badge (hipfire has no
  `--ctx`-equivalent surfaced here — uses a named `HIPFIRE_DEFAULT_MAX_SEQ = 32768` constant,
  citing hipfire's server-side default) now key off it. Unit-tested (llama with/without model,
  hipfire with/without tag, running-hipfire-while-toggle-flipped-to-llama and the reverse).
- **B — Reasoning toggle.** hipfire's thinking is config-driven (`hipfire config set
  thinking`/`thinking_budget`) and not request-controllable at all (fact 4, prior pass) — the
  toggle is now always shown inactive under hipfire with a tooltip explaining why, folded into
  the same `thinkingKnownUnsupported` flag llama's "no thinking mode in this template" case
  already used (so the composer's `n/a` label falls out for free).
- **C — Model switcher overlay (`ModelLibraryOverlay.tsx`) unified.** Added a compact engine
  switch at the top, wired to the same `setEngineKind` Configure uses (no parallel state). Under
  `engine_kind=hipfire` the table lists local hipfire models via the existing
  `list_hipfire_models` wrapper (tag + size, `-draft` tags annotated as draft companions);
  picking one writes `hipfire_flags.tag` and calls `reloadServer()`, same as the llama row's
  Load button. `loadedKey`/selected state keys off the active engine's identity. A failed
  `list_hipfire_models` call (hipfire not installed) surfaces as a small inline error, not a
  crash. modelInfo-derived badges (architecture/MTP/size) render llama-only. The llama branch is
  byte-identical to before.
- **D — modelInfo hygiene.** The GGUF-inspect effect (`state/effects.tsx`) that populates
  `modelInfo` is llama-only (hipfire has no `/props` endpoint — fact 5, prior pass); it's now
  gated on `activeEngine`, clearing `modelInfo` immediately whenever hipfire becomes the active
  engine (and re-fetching if the user switches back), so stale llama GGUF data can never drive
  the reasoning tooltip or the overlay's details while hipfire is active.
- **E — Tools visibility on hipfire.** Request shaping is unchanged (tools stay stripped — see
  the probe above). `SessionConfigFields.tsx` (the chat sidebar's session config, shared with
  the workspace-defaults overlay) now accepts a `toolsDisabledForEngine` flag; when the active
  engine is hipfire, `ChatSidebar` passes `true` and the MCP-server checkboxes + the project-
  folder tools note render an inline "disabled for hipfire" badge/tooltip citing the force-EOS
  behavior above — controls stay visible and configured, just inactive, per the same-UX
  principle. `WorkspaceConfigOverlay` (workspace defaults, not a live conversation) doesn't pass
  the flag, so it's unaffected.
- **F — Branding sweep.** A handful of user-facing strings described the RUNNING server as
  llama regardless of which engine was actually up: the top bar's model badge/Stop-button
  title, the sidebar's runtime card, the status bar's live label, the command palette's
  "Stop llama-server" entry, and the two "Start llama-server on the Configure tab first" chat
  toasts. All now key off `activeEngine` (or `settings.engine_kind` where the string genuinely
  describes a next-launch target, e.g. the status bar's argv preview, which was already
  correct). `engineBinaryName` moved to `lib/chatUi.ts` so both `App.tsx` and
  `CommandPalette.tsx` share one implementation instead of duplicating it. Configure's own
  llama-specific sections (build picker, binary locator, flag groups) were left alone — a llama
  user sees byte-identical copy throughout.

All of the above is frontend-only and behind `activeEngine`/`settings.engine_kind`; no request
shaping, `activeEngine` semantics, or Rust backend changed. `cargo test --lib` in `src-tauri`
stays green untouched.
