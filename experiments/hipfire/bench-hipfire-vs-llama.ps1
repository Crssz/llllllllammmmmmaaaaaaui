<#
  bench-hipfire-vs-llama.ps1

  GATE experiment for the hipfire integration decision.
  Question it answers: on THIS machine's R9700 (gfx1201), is hipfire meaningfully
  faster than the llama.cpp *Vulkan* build lm-st already drives -- and does it hold
  the flat decode-vs-context-depth curve that is hipfire's one real differentiator?

  If the answer is "no" on both, stop here. That is the ZINC lesson bought for the
  price of one afternoon instead of a 33-file integration that gets reverted.

  HOW IT'S FAIR: both hipfire and llama-server expose an OpenAI-compatible
  POST /v1/chat/completions with SSE streaming. This harness drives BOTH through
  that one endpoint, with identical prompts / output length / depth sweep, and
  measures steady-state DECODE tok/s (tokens after the first, over wall time after
  the first token) plus time-to-first-token. Same yardstick, same model weights
  class, two engines.

  It does NOT build hipfire, install the HIP SDK, or convert models -- those are
  manual one-time steps documented in bench-hipfire-vs-llama.README.md. This script
  assumes you already have BOTH servers running (or it can start llama-server for
  you if you pass -LlamaServerExe + -ModelGguf).

  PowerShell 5.1 compatible. Read-only w.r.t. your system (HTTP + optional child
  process it starts and stops itself).
#>

[CmdletBinding()]
param(
  # --- Endpoints (start the servers yourself, or let this script start llama-server) ---
  [string]$HipfireUrl   = "http://127.0.0.1:11435/v1/chat/completions",
  [string]$LlamaUrl     = "http://127.0.0.1:8080/v1/chat/completions",

  # hipfire wants the registry tag / loaded model name; llama-server ignores it ("local").
  [string]$HipfireModel = "qwen3.6:27b",
  [string]$LlamaModel   = "local",

  # --- Depth sweep: approximate prompt sizes (in tokens) to fill the KV cache to ---
  # This is where hipfire claims to stay flat while llama.cpp ROCm degrades. Trim the
  # big ones if a model/card can't hold them.
  [int[]]$DepthsTokens  = @(1024, 8192, 32768, 65536, 131072),

  [int]$GenTokens       = 200,   # fixed decode length measured at each depth
  [int]$Warmups         = 1,     # discarded runs to warm kernels / KV
  [int]$Runs            = 3,     # measured runs per depth (median reported)

  # --- Optional: let the script manage a llama-server child for the llama side ---
  [string]$LlamaServerExe = "",  # e.g. F:\llama\build\bin\llama-server.exe (Vulkan build)
  [string]$ModelGguf      = "",  # e.g. F:\models\qwen\qwen3.6-27b\Qwen3.6-27B-Q4_K_M.gguf
  [string]$LlamaExtraArgs = "-ngl 999 -c 131072 --flash-attn on --port 8080",

  [switch]$SkipHipfire,          # bench only llama (sanity)
  [switch]$SkipLlama,            # bench only hipfire
  [string]$OutJson = ""          # optional: write full results as JSON here
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http | Out-Null

# ---------------------------------------------------------------------------
# Prompt padding: build a user message of roughly N tokens. ~0.75 tokens/word
# for English, so ~1.35 words/token; we pad with a deterministic filler and cap
# by word count. Not exact, but IDENTICAL across both engines => fair comparison.
# ---------------------------------------------------------------------------
function New-PaddedPrompt {
  param([int]$TargetTokens)
  $words = [Math]::Max(8, [int]($TargetTokens * 1.35))
  $filler = (1..$words | ForEach-Object { "word$($_ % 97)" }) -join ' '
  # A concrete instruction at the end so the model actually decodes GenTokens.
  return "Here is some reference material, ignore its content:`n$filler`n`nNow write a long, continuous explanation of how a CPU cache works. Do not stop early."
}

# ---------------------------------------------------------------------------
# One streamed request. Returns @{ ttft_s; decode_tps; decode_tokens; total_s; ok }
# decode_tps = (content_chunks - 1) / (t_last - t_first). Each SSE delta ~= 1 token
# for both llama-server and hipfire, so this is a fair token proxy on both sides.
# ---------------------------------------------------------------------------
function Invoke-StreamBench {
  param([string]$Url, [string]$Model, [string]$Prompt, [int]$MaxTokens)

  $bodyObj = @{
    model    = $Model
    stream   = $true
    messages = @(@{ role = "user"; content = $Prompt })
    max_tokens  = $MaxTokens
    temperature = 0.0
    # ask for usage if the server supports it (llama does; hipfire may not -- harmless)
    stream_options = @{ include_usage = $true }
  }
  $json = $bodyObj | ConvertTo-Json -Depth 6 -Compress

  $client = New-Object System.Net.Http.HttpClient
  $client.Timeout = [TimeSpan]::FromMinutes(10)
  try {
    $req = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Post, $Url)
    $req.Content = New-Object System.Net.Http.StringContent($json, [System.Text.Encoding]::UTF8, "application/json")

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $resp = $client.SendAsync($req, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
    if (-not $resp.IsSuccessStatusCode) {
      $errBody = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      throw "HTTP $([int]$resp.StatusCode) from $Url : $errBody"
    }

    $stream = $resp.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $reader = New-Object System.IO.StreamReader($stream)

    $tFirst = $null; $tLast = $null; $chunks = 0; $usageTokens = $null
    while (-not $reader.EndOfStream) {
      $line = $reader.ReadLine()
      if ([string]::IsNullOrWhiteSpace($line)) { continue }
      if (-not $line.StartsWith("data:")) { continue }
      $data = $line.Substring(5).Trim()
      if ($data -eq "[DONE]") { break }
      try { $obj = $data | ConvertFrom-Json } catch { continue }

      $delta = $null
      if ($obj.choices -and $obj.choices.Count -gt 0) { $delta = $obj.choices[0].delta }
      $piece = $null
      if ($delta) {
        if ($delta.content) { $piece = $delta.content }
        elseif ($delta.reasoning_content) { $piece = $delta.reasoning_content } # think phase counts as decode
      }
      if ($piece) {
        if ($null -eq $tFirst) { $tFirst = $sw.Elapsed.TotalSeconds }
        $tLast = $sw.Elapsed.TotalSeconds
        $chunks++
      }
      if ($obj.usage -and $obj.usage.completion_tokens) { $usageTokens = [int]$obj.usage.completion_tokens }
    }
    $sw.Stop()
    $reader.Dispose()

    if ($null -eq $tFirst -or $chunks -lt 2) {
      return @{ ok = $false; reason = "no/too-few tokens streamed"; total_s = $sw.Elapsed.TotalSeconds }
    }
    $decodeTokens = if ($usageTokens) { $usageTokens } else { $chunks }
    $decodeSpan = [Math]::Max(1e-6, ($tLast - $tFirst))
    $decodeTps = ($chunks - 1) / $decodeSpan   # chunk-based so both engines are measured identically
    return @{
      ok = $true
      ttft_s = [Math]::Round($tFirst, 3)
      decode_tps = [Math]::Round($decodeTps, 2)
      decode_tokens = $decodeTokens
      total_s = [Math]::Round($sw.Elapsed.TotalSeconds, 3)
    }
  }
  finally { $client.Dispose() }
}

function Test-Endpoint {
  param([string]$Url)
  $base = ($Url -replace '/v1/chat/completions$', '')
  try { Invoke-WebRequest -Uri "$base/health" -TimeoutSec 5 -UseBasicParsing | Out-Null; return $true }
  catch { return $false }
}

function Measure-Engine {
  param([string]$Name, [string]$Url, [string]$Model)
  Write-Host "`n=== $Name @ $Url ===" -ForegroundColor Cyan
  if (-not (Test-Endpoint -Url $Url)) {
    Write-Host "  /health did not respond -- is the server up and the model loaded?" -ForegroundColor Yellow
  }
  $rows = @()
  foreach ($depth in $DepthsTokens) {
    $prompt = New-PaddedPrompt -TargetTokens $depth
    for ($w = 0; $w -lt $Warmups; $w++) {
      try { Invoke-StreamBench -Url $Url -Model $Model -Prompt $prompt -MaxTokens $GenTokens | Out-Null } catch {}
    }
    $samples = @()
    for ($r = 0; $r -lt $Runs; $r++) {
      try {
        $res = Invoke-StreamBench -Url $Url -Model $Model -Prompt $prompt -MaxTokens $GenTokens
        if ($res.ok) { $samples += $res } else { Write-Host "  depth $depth run $r : $($res.reason)" -ForegroundColor Yellow }
      } catch {
        Write-Host "  depth $depth run $r FAILED: $($_.Exception.Message)" -ForegroundColor Red
      }
    }
    if ($samples.Count -gt 0) {
      $tps = ($samples | ForEach-Object { $_.decode_tps } | Sort-Object)
      $ttft = ($samples | ForEach-Object { $_.ttft_s } | Sort-Object)
      $medTps  = $tps[[int]([Math]::Floor(($tps.Count-1)/2))]
      $medTtft = $ttft[[int]([Math]::Floor(($ttft.Count-1)/2))]
      $rows += [pscustomobject]@{
        Engine = $Name; DepthTokens = $depth; DecodeTps = $medTps; TtftSec = $medTtft; Samples = $samples.Count
      }
      Write-Host ("  depth {0,7} : {1,7:N1} tok/s decode   (ttft {2,6:N2}s, n={3})" -f $depth, $medTps, $medTtft, $samples.Count)
    } else {
      $rows += [pscustomobject]@{ Engine=$Name; DepthTokens=$depth; DecodeTps=$null; TtftSec=$null; Samples=0 }
      Write-Host ("  depth {0,7} : no successful runs" -f $depth) -ForegroundColor Red
    }
  }
  return $rows
}

# ---------------------------------------------------------------------------
# Optional: manage a llama-server child (Vulkan build) for the llama side.
# ---------------------------------------------------------------------------
$llamaProc = $null
if (-not $SkipLlama -and $LlamaServerExe -and $ModelGguf) {
  if (-not (Test-Path $LlamaServerExe)) { throw "LlamaServerExe not found: $LlamaServerExe" }
  if (-not (Test-Path $ModelGguf))      { throw "ModelGguf not found: $ModelGguf" }
  Write-Host "Starting llama-server (Vulkan) ..." -ForegroundColor Cyan
  $args = "-m `"$ModelGguf`" $LlamaExtraArgs"
  $llamaProc = Start-Process -FilePath $LlamaServerExe -ArgumentList $args -PassThru -WindowStyle Hidden
  $deadline = (Get-Date).AddSeconds(600)
  while ((Get-Date) -lt $deadline -and -not (Test-Endpoint -Url $LlamaUrl)) { Start-Sleep -Milliseconds 500 }
  if (-not (Test-Endpoint -Url $LlamaUrl)) { throw "llama-server did not become ready within 600s" }
  Write-Host "llama-server ready (pid $($llamaProc.Id))." -ForegroundColor Green
}

$all = @()
try {
  if (-not $SkipHipfire) { $all += Measure-Engine -Name "hipfire"    -Url $HipfireUrl -Model $HipfireModel }
  if (-not $SkipLlama)   { $all += Measure-Engine -Name "llama-vulkan" -Url $LlamaUrl -Model $LlamaModel }
}
finally {
  if ($llamaProc -and -not $llamaProc.HasExited) {
    Write-Host "`nStopping llama-server (pid $($llamaProc.Id)) ..." -ForegroundColor Cyan
    Stop-Process -Id $llamaProc.Id -Force -ErrorAction SilentlyContinue
  }
}

# ---------------------------------------------------------------------------
# Verdict table: side-by-side + the two decision numbers.
# ---------------------------------------------------------------------------
Write-Host "`n================ RESULTS ================" -ForegroundColor Green
$all | Format-Table Engine, DepthTokens, DecodeTps, TtftSec, Samples -AutoSize | Out-String | Write-Host

if (-not $SkipHipfire -and -not $SkipLlama) {
  $hf = $all | Where-Object Engine -eq "hipfire"
  $ll = $all | Where-Object Engine -eq "llama-vulkan"
  $baseDepth = $DepthsTokens[0]
  $hfBase = ($hf | Where-Object DepthTokens -eq $baseDepth).DecodeTps
  $llBase = ($ll | Where-Object DepthTokens -eq $baseDepth).DecodeTps

  Write-Host "DECISION NUMBER 1 -- raw decode speed at shallow context ($baseDepth tok):" -ForegroundColor Green
  if ($hfBase -and $llBase) {
    $ratio = [Math]::Round($hfBase / $llBase, 2)
    Write-Host ("  hipfire {0:N1} vs llama-vulkan {1:N1} tok/s  =>  hipfire is {2}x" -f $hfBase, $llBase, $ratio)
    Write-Host "  Rule of thumb: < ~1.2x here and there is little raw-speed reason to switch."
  } else { Write-Host "  (missing a base-depth sample on one side)" -ForegroundColor Yellow }

  Write-Host "`nDECISION NUMBER 2 -- long-context flatness (hipfire's real differentiator):" -ForegroundColor Green
  Write-Host "  Look at each engine's DecodeTps as DepthTokens climbs. hipfire's claim is a"
  Write-Host "  nearly flat line to 130K+ while llama.cpp ROCm collapses on the DeltaNet"
  Write-Host "  (Qwen3.5/3.6) family. If BOTH stay flat, that differentiator is moot on your"
  Write-Host "  Vulkan build. If llama-vulkan collapses and hipfire holds, THAT is the reason"
  Write-Host "  to integrate -- nothing else in the numbers is."
}

if ($OutJson) { $all | ConvertTo-Json -Depth 6 | Out-File -FilePath $OutJson -Encoding utf8; Write-Host "`nWrote $OutJson" }
