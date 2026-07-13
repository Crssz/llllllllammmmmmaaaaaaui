# hipfire integration plan for lm-st

**Status: APPROVED — implementing now** (user opted to skip the benchmark gate, 2026-07-14).
Everything ships behind an `engine_kind` toggle defaulting to `"llama"`, so `main` stays
shippable at every step and the llama path is byte-identical when the toggle is untouched.

**Environment note:** hipfire is NOT running in the build environment, so the handful of
HTTP-dialect specifics in Phase 0 cannot be probed live. They are implemented from hipfire's
documented behavior with sensible defaults, and every such assumption is marked in code with
`// TODO(hipfire-verify): <what to confirm against a live hipfire server>` so they can be
validated in one pass once a real hipfire is up on the R9700.

**Strategy.** Do *not* build a hipfire-specific fork of the app. Build a **generic engine
axis** (llama | hipfire) and add hipfire as the second engine. A prior branch,
`zinc-integration`, already made the same mechanical Rust change (parameterized
`start_server`, an engine settings axis) and fixed the lifecycle bugs a second engine hits —
consult its diff as a *mechanical reference only* (see Handoff), but implement cleanly for
hipfire; do not carry over zinc-specific names or code.

**The genuinely new piece:** hipfire cannot serve raw `.gguf`. It needs an **offline
conversion pipeline** (`hipfire quantize` → its own `.mq4/.hf4` store). This is net-new
architectural work and the biggest risk item.

---

## Phase 0 — HTTP-dialect assumptions (implement as documented, mark as TODO)

The research nailed hipfire's *shape*; these OpenAI-compat *details* need eventual
confirmation against a live server. Implement each with the documented default below and a
`// TODO(hipfire-verify)` marker:

- **`/health`**: implemented as returns HTTP 200 when ready (lm-st's probe only checks for
  `200`). Assumption: not 503-while-loading. → `probe_health`.
- **Port flag**: hipfire takes positional `host:port` / config, not `--port`. The launcher
  must pass `127.0.0.1:<port>` positionally and `parse_port` must read hipfire's form. →
  `parse_port`.
- **`/v1/chat/completions` body**: default assumptions to encode — accepts the loaded model
  tag as `model` (send the configured hipfire tag, not `"local"`); may emit no final `usage`
  frame (so `finalizeTokenStats` needs a chunk-count fallback gated to hipfire); reasoning
  arrives as `delta.reasoning_content`; tool-call streaming and `image_url`/`input_audio`
  support unverified → gate media/tools off for hipfire until confirmed. Each of these is a
  `shapeChatBody(engine, …)` branch.

---

## Phase 1 — Rust backend (small, mostly cherry-pick from `zinc-integration`)

Cherry-pick the server.rs + settings.rs commits from the zinc branch; they generalize cleanly.

1. **`src-tauri/src/server.rs`**
   - `start_server` (:104): add `exe_path: Option<String>` + `env: Option<Vec<(String,String)>>`.
     `exe_path` set → spawn it directly, cwd = its parent (sibling DLLs resolve); `None` →
     unchanged llama-server resolution. Layer `env` over inherited env. *(verbatim from zinc)*
   - `parse_port` (:89): teach it hipfire's port source (positional/config) or have the
     launcher pass an explicit `--port`-equivalent.
   - `probe_health` (:68): confirm Phase-0 answer. If hipfire's `/health` isn't a plain 200,
     parameterize the readiness predicate per engine, or `ready` never flips and every chat
     send blocks at `chatSlice.ts:428`.
2. **`src-tauri/src/settings.rs`**: add `engine_kind: String` (serde default `"llama"`),
   `hipfire_path: String`, `hipfire_flags: serde_json::Value` (a **separate** flag bag, not
   merged into `flags`). Add the same three to `SavedProfile`. **Hand-write `impl Default for
   Settings`** — serde `default=` does NOT apply to `Settings::default()`; zinc hit this as a
   first-run trap. Add legacy-load tests (old settings.json without the new fields must load).
3. **(Optional) `src-tauri/src/gguf.rs`**: cherry-pick `tensor_types` (tensor-table walk +
   `ggml_type_name`) if you want a pre-launch compatibility check (hipfire is VRAM-only, no
   CPU offload → a wrong-size or unsupported-quant model is a hard OOM, worth pre-flighting).

**Difficulty: implementer-easy** for the settings + parameterized spawn (well-specified,
cherry-pickable). **implementer-hard** only if the health predicate needs real
per-engine abstraction.

---

## Phase 2 — model conversion pipeline (NEW; the real work)

hipfire needs `.mq4/.hf4` files, not the `.gguf` files in `F:\models` and the HF catalog.

- **Conversion command wrapper** (new Rust command, e.g. `src-tauri/src/hipfire_convert.rs`):
  shell out to `hipfire quantize <gguf> --format hf4|mq4 --install --register <tag>`, stream
  progress as events (mirror the bench-progress pattern in `bench.rs`), handle the CPU-bound
  wait (seconds to minutes).
- **Parallel model store**: hipfire keeps converted models in `~/.hipfire/models/`. Decide:
  surface hipfire's own `list`/registry, or track conversions in lm-st settings and map
  `gguf path → converted tag`. The existing `models_scan.rs` GGUF tree is llama-only; hipfire
  model discovery is a separate view.
- **Quantizer gaps to guard**: source types Q4_0/Q8_0/Q4_K/Q5_K/Q6_K/F16/BF16/F32 are
  supported; IQ-quants, Q5_0/Q5_1, Q2_K/Q3_K panic. Pre-check the GGUF's tensor types
  (Phase-1 `tensor_types`) and refuse with a clear message rather than letting the child
  panic. Warn that GGUF→hipfire is lossy double-quantization; recommend Q6_K/Q8_0 sources.

**Difficulty: implementer-hard.** This has no zinc precedent, touches process orchestration,
a new store abstraction, and error handling for a tool that panics on bad input.

---

## Phase 3 — frontend (take the zinc diff nearly verbatim, it encodes the fixes)

4. **`src/lib/api.ts`**: `startServer` signature (exePath/env), `EngineKind` type,
   `Settings`/`SavedProfile` fields, `pickExecutable` (.exe dialog for the hipfire binary).
5. **`src/lib/buildHipfireArgs.ts`** (new) + **`HIPFIRE_FLAG_GROUPS`** in `src/data.ts`:
   hipfire's argv (serve tag/host/port, `--kv-mode`, `--idle-timeout`, spec flags
   `--spec/-md/--draft-max`, `--tp`). Reuses the `FlagRow` renderer. Note spec flag spellings
   differ from llama's `--spec-type`/`--model-draft`.
6. **`src/state/slices/serverSlice.ts`** (the heart — take zinc's version): `activeArgs(get)`
   picks the builder by engine; `launchPrereqError(get)` returns per-engine preconditions
   (hipfire: exe path + model; llama: build_dir); `loadedEngine` field records what the
   RUNNING server is, distinct from the `engine_kind` toggle; engine-aware
   `startServer/reloadServer/reloadIfStale`. **Critical fix from zinc (commit 36fca4e):**
   validate `launchPrereqError` BEFORE tearing down a healthy server, in all three of
   `startServer`, `reloadServer`, `reloadIfStale` — otherwise a toggle makes `loadedArgs`
   differ from `activeArgs`, kills the running server, then discovers the new engine can't
   launch.
7. **`src/lib/chatHelpers.ts`**: `shapeChatBody(engine, parts)` branch for hipfire per the
   Phase-0 answers (model id, drop `stream_options` if no usage frame, reasoning mechanism,
   template handling, media gating). `finalizeTokenStats` engine-gated fallback (chunk-count
   tps estimate only if hipfire emits no usage — never fabricate for llama).
8. **`src/state/slices/chatSlice.ts`**: thread engine into body shaping + token stats; gate
   media if hipfire is text-only (replace dropped attachments with a placeholder so empty
   content never 400s and poisons history — zinc bug f4bfff2).
9. **`src/state/slices/transcribeSlice.ts`**: gate on `loadedEngine` (the running engine),
   falling back to `engine_kind` when no server is up (zinc bug: keying on the toggle broke a
   live llama-server after a flip).
10. **`src/state/slices/settingsSlice.ts`** + **`src/state/effects.tsx`**: `EMPTY_SETTINGS`
    fields, `setEngineKind`/`setHipfirePath`/`setHipfireFlag`, normalize engine keys on load.
11. **`src/screens/Configure.tsx`**: engine toggle (label it "switching does not restart the
    server"), hipfire exe locator + flag groups, hide llama-only sections under hipfire
    (BinaryLocator, spec/templates/rope, mmproj), engine-aware start gating + command
    preview/copy (currently hardcodes `llama-server` at :250/:318/:367), optional compat notice.
12. **`src/App.tsx`**: `engineBinaryName()` for sidebar/statusbar labels + cmd snippet.
13. **`src/screens/Bench.tsx`** (llama-bench banner — hipfire has no llama-bench; leave
    llama-only), **`src/screens/EngineManager.tsx`** (scope note: manages llama.cpp builds
    only), **`src/screens/Profiles.tsx`** + **`profilesSlice.ts`** (engine badge, engine-aware
    save/apply).
14. **Free riders** once serverSlice dispatches: Models/Catalog/ModelLibraryOverlay "Load"
    buttons, 2s status polling, log panel, window-destroy cleanup — all engine-agnostic already.

**Difficulty: mixed.** serverSlice + chatHelpers dispatch = **implementer-hard** (the
lifecycle and compat logic is where zinc bled). Configure UI, data.ts flag groups, label
plumbing, buildHipfireArgs = **implementer-easy** (mechanical, well-specified).

---

## Phase 4 — defend against the three failure classes zinc hit

1. **Engine-switch lifecycle**: prereq-check before teardown (Phase 3 item 6). Add a test.
2. **Two sources of truth**: `engine_kind` (toggle) vs `loadedEngine` (process) — every
   feature gate must pick the right one. Audit transcribe, media, labels.
3. **"OpenAI-compatible" drift**: the Phase-0 probe answers must all be wired, not assumed.

## Out of scope / decoupling (note, don't necessarily fix now)

- **GPU telemetry** (`hw.rs`) finds `amdhip64_*.dll` via a hint seeded from the *llama*
  build_dir (`lib.rs:46-59,148-154`). Under hipfire-only config that hint is empty and AMD
  VRAM readout silently breaks. Decouple the DLL search from the llama build_dir, or seed the
  hint from the HIP SDK / rocm\bin path.
- **`model_configs`** per-model bag is llama-flag-shaped; hipfire flags won't participate in
  per-model persistence without a parallel bag (zinc left this as a known gap).

---

## Handoff

Delegated to a single Sonnet implementer agent, building Phases 1→3 in dependency order
(Rust backend first, then conversion command, then frontend), on a feature branch.

- Keep everything behind the `engine_kind` toggle defaulting to `"llama"` so `main` stays
  shippable throughout, and the llama path stays byte-identical when the toggle is untouched.
- Definition of done for this milestone: `npm run build` + typecheck + lint + `npm test`
  (vitest) all pass; `cargo build` + `cargo test` pass; the app still launches and drives
  llama-server exactly as before; hipfire support is present behind the toggle with every
  unverifiable dialect detail marked `// TODO(hipfire-verify)`.
- **Mechanical reference (optional):** a prior `zinc-integration` branch made the identical
  parameterized-spawn + settings-axis change. Its diff is a shortcut for the Rust plumbing —
  ```
  git diff main...zinc-integration -- src-tauri/src/server.rs src-tauri/src/settings.rs
  ```
  Consult it for the *pattern* only; implement cleanly for hipfire, no zinc-specific naming.
