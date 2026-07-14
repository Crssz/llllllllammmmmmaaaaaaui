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
