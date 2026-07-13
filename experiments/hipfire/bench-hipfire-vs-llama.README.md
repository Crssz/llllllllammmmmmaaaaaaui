# Gate experiment: hipfire vs llama.cpp Vulkan on the R9700

**Purpose.** Decide whether hipfire is worth integrating into lm-st *before* writing
any integration code. Two numbers decide it:

1. **Raw decode tok/s** at shallow context vs the llama.cpp **Vulkan** build lm-st
   already drives. If it's not meaningfully faster (rule of thumb < ~1.2×), the raw-speed
   case is dead — same as ZINC.
2. **Long-context flatness.** hipfire's one genuinely corroborated differentiator is a
   nearly flat decode curve to 130K+ tokens on the Qwen3.5/3.6 DeltaNet family, where
   llama.cpp's ROCm path has documented collapse. **If your llama.cpp *Vulkan* build
   also stays flat, this differentiator is moot on your hardware and the answer is no.**

If both numbers come back unimpressive, stop. That is the whole point of running this
first: an afternoon instead of a 33-file integration that gets reverted.

---

## Machine status (checked 2026-07-13)

- HKLM PATH stray-quote bug (the "cargo not found" trap): **fixed / clean.**
- `...\rocm\bin` is on the machine PATH, so the **HIP runtime is installed.** You still
  need the HIP **SDK** (`hipcc`) for hipfire's kernel build — verify below.
- You have multiple R9700s, but hipfire multi-GPU (PR #382) is an unmerged draft, so this
  runs **single-GPU**. Pin one card: `$env:HIP_VISIBLE_DEVICES = "0"`.

---

## One-time setup (manual — the script does NOT do these)

### 0. Verify the toolchain
```powershell
hipcc --version          # need the AMD HIP SDK for Windows, 6.4.2+ (7.1.x current) for gfx1201
cargo --version          # Rust toolchain (rustup)
bun --version            # hipfire's CLI wrapper needs Bun; install.ps1 auto-installs it
```
If `hipcc` is missing, install the **AMD HIP SDK for Windows** (7.1.1 officially lists
Radeon AI PRO R9700 / gfx1201 on Win11). The runtime alone (rocm\bin) is not enough to
compile kernels.

### 1. Build hipfire from source
Current releases (v0.2.x) ship **no binaries**, so a source build is required.
```powershell
git clone https://github.com/Kaden-Schutt/hipfire
cd hipfire
# The installer auto-detects the GPU, but its regex does NOT match "Radeon AI PRO R9700".
# When it prompts for the arch, type:  gfx1201
.\scripts\install.ps1
# Precompile kernels for your arch (avoids first-request JIT stalls):
.\scripts\compile-kernels.ps1 -Arch gfx1201    # gfx1201 is in the default target list
```
If `install.ps1` stalls at the GPU prompt in a non-interactive shell, run it interactively
once. Sanity-check the engine loads the card before benchmarking:
```powershell
$env:HIP_VISIBLE_DEVICES = "0"
hipfire ps
```

### 2. Get a model in hipfire's format
hipfire **cannot serve a raw .gguf** — convert once (CPU-only, no Python; ~1–2 min for 9B,
4–8 min for 27B). Two honest options:

- **Fastest to run (what the benchmark defaults to):** pull the native build so there's no
  double-quantization confound —
  ```powershell
  hipfire pull qwen3.6:27b        # or qwen3.5:9b for a quick first pass
  ```
- **Apples-to-apples with your exact GGUF weights** (fairer, but hipfire re-quantizes a
  GGUF that's already quantized → some quality loss; speed is still valid) —
  ```powershell
  hipfire quantize "F:\models\qwen\qwen3.6-27b\Qwen3.6-27B-Q4_K_M.gguf" --install --register qwen3.6:27b-local
  ```
  Note: the quantizer handles Q4_0/Q8_0/Q4_K/Q5_K/Q6_K/F16/BF16/F32 GGUF source types;
  IQ-quants and Q5_0/Q5_1 panic (not implemented). Use a Q4_K_M / Q6_K / Q8_0 source.

### 3. Start hipfire's server
```powershell
$env:HIP_VISIBLE_DEVICES = "0"
hipfire serve qwen3.6:27b 127.0.0.1:11435 -d      # -d = detach; logs in ~/.hipfire/serve.log
```

### 4. Have the llama.cpp **Vulkan** build ready
Use the same Vulkan build lm-st uses (its `build_dir`). The benchmark can start it for you
(pass `-LlamaServerExe` + `-ModelGguf`) or you start it yourself on port 8080. Make sure
it's the **Vulkan** backend, not ROCm — the whole comparison hinges on that, because ROCm
is the baseline hipfire beats and Vulkan is the one lm-st actually runs.

---

## Run the benchmark

**Both servers already running** (hipfire :11435, llama :8080):
```powershell
.\bench-hipfire-vs-llama.ps1 -HipfireModel qwen3.6:27b -OutJson result.json
```

**Let the script manage llama-server** (recommended for a clean run):
```powershell
.\bench-hipfire-vs-llama.ps1 `
  -HipfireModel qwen3.6:27b `
  -LlamaServerExe "F:\llama\build\bin\llama-server.exe" `
  -ModelGguf "F:\models\qwen\qwen3.6-27b\Qwen3.6-27B-Q4_K_M.gguf" `
  -LlamaExtraArgs "-ngl 999 -c 131072 --flash-attn on --port 8080" `
  -OutJson result.json
```

**Quick first pass** (smaller model, shallower sweep) to shake out setup:
```powershell
.\bench-hipfire-vs-llama.ps1 -HipfireModel qwen3.5:9b -DepthsTokens 1024,8192,32768 -Runs 2
```

Trim `-DepthsTokens` if a card/model can't hold 131072. `-SkipLlama` / `-SkipHipfire`
benchmark one side alone.

---

## Reading the result

The script prints a side-by-side table and two decision numbers. Interpretation:

| Outcome | Verdict |
|---|---|
| hipfire < ~1.2× at shallow depth **and** llama-vulkan stays flat with depth | **No** — no raw-speed win, differentiator moot. Stop. Same as ZINC. |
| hipfire ≈ llama at shallow depth **but** llama-vulkan collapses with depth while hipfire holds flat | **Yes, for long-context** — this is the one real reason to integrate. |
| hipfire ≫ llama at shallow depth (unlikely vs Vulkan, per the research) | Re-run to rule out a misconfigured (non-Vulkan / non-flash-attn) llama build, then reconsider. |

Also eyeball output quality by hand on a couple of prompts — hipfire's MQ4 quant measured
~4.5× worse KLD than llama.cpp's Q4_K-class, and quant-induced token attractors are a
recurring bug class. A faster engine that degrades answers is a net loss.

Only if the verdict is **Yes** do you proceed to the integration plan.
