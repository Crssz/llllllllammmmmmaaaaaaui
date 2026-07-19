//! `hipfire bench` integration: run hipfire's own throughput benchmark against
//! a locally-registered tag and parse its text summary.
//!
//! Mirrors `hipfire_pull.rs`'s process-orchestration pattern: a sync command
//! spawns the child, hands the pipes to detached pump threads, and returns
//! immediately. The child lives in a shared `Arc<Mutex<Option<Child>>>` so
//! `cancel_hipfire_bench` can kill it from the main thread while the reaper
//! thread waits on it. A generation counter (bumped on every run / cancel)
//! ensures a superseded or cancelled run never emits a stale
//! `hipfire-bench-done`.
//!
//! Unlike `hipfire_pull`, a bench run also needs its full output parsed once
//! it finishes (fact 1, 2026-07-19 live capture): both stdout and stderr
//! lines are streamed raw to the frontend via `hipfire-bench-progress` AND
//! accumulated into a shared buffer, so the reaper thread can hand the done
//! event both the raw text and a structured `parse_hipfire_bench_summary`
//! result — the frontend renders the summary without re-implementing the
//! text parser in TypeScript.
//!
//! `hipfire bench` has no `--help` and no JSON output mode — everything here
//! is text-scraped against the live-captured fixture (see the `tests` module).
//! A bench run holds the model resident in VRAM (~15GB for the fact-1
//! fixture's 27B model), so `cancel_hipfire_bench` always tree-kills, same as
//! `cancel_hipfire_convert`/`cancel_hipfire_pull`.

use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::Child;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use log::{debug, error, info};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::build_scan::quiet_command;
use crate::server::{kill_child_tree, resolve_hipfire_bin};
use crate::util::lock_or_poisoned;

/// Managed state for the (single) in-flight benchmark.
pub struct HipfireBenchState {
    pub child: Arc<Mutex<Option<Child>>>,
    pub generation: Arc<AtomicU64>,
    pub cancel: Arc<AtomicBool>,
}

impl HipfireBenchState {
    pub fn new() -> Self {
        Self {
            child: Arc::new(Mutex::new(None)),
            generation: Arc::new(AtomicU64::new(0)),
            cancel: Arc::new(AtomicBool::new(false)),
        }
    }
}

impl Default for HipfireBenchState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Serialize)]
struct HipfireBenchProgressEvent {
    generation: u64,
    line: String,
}

#[derive(Clone, Serialize)]
struct HipfireBenchDoneEvent {
    generation: u64,
    ok: bool,
    cancelled: bool,
    error: Option<String>,
    tag: String,
    /// Full captured stdout+stderr text (interleaved in read order — the two
    /// streams are pumped on separate threads so exact cross-stream ordering
    /// isn't guaranteed, but that doesn't matter to the line-oriented parser
    /// below).
    output: String,
    summary: Option<HipfireBenchSummary>,
}

// ── Parsed summary ──────────────────────────────────────────────────────────

/// Header key/value fields from `hipfire bench`'s pre-run block.
#[derive(Debug, Clone, Serialize, Default, PartialEq)]
pub struct HipfireBenchHeader {
    pub model: Option<String>,
    pub arch: Option<String>,
    pub gpu: Option<String>,
    pub kv_cache: Option<String>,
    pub max_seq: Option<String>,
    pub vram: Option<String>,
    pub runs: Option<String>,
    pub mode: Option<String>,
}

/// One stats row (either a `pp<N>` prefill-sweep row, with `ms` set, or a
/// named summary row — Prefill/TTFT/Decode/Wall — with `ms` unset).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct HipfireBenchStatRow {
    pub label: String,
    pub mean: f64,
    pub min: f64,
    pub max: f64,
    pub stdev: f64,
    pub ms: Option<f64>,
}

/// Full parsed result of a `hipfire bench` run.
#[derive(Debug, Clone, Serialize, Default, PartialEq)]
pub struct HipfireBenchSummary {
    pub header: HipfireBenchHeader,
    /// pp128/pp512/pp1024/pp2048 sweep rows, in the order they appeared.
    pub prefill: Vec<HipfireBenchStatRow>,
    /// Prefill/TTFT/Decode/Wall summary rows, in the order they appeared.
    pub summary: Vec<HipfireBenchStatRow>,
    pub decode_ms_per_tok: Option<f64>,
}

/// Match a trimmed line against `"<key>:"` and return the trimmed remainder,
/// or `None` if it doesn't start with that exact key.
fn parse_kv_line(trimmed: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}:");
    trimmed.strip_prefix(&prefix).map(|v| v.trim().to_string())
}

/// A `pp<N>` prefill-sweep row: `pp128               822.7    822.7    822.7      0.0   155.6`
/// → label, mean, min, max, stdev, ms (5 numeric columns).
fn parse_prefill_row(trimmed: &str) -> Option<HipfireBenchStatRow> {
    let mut it = trimmed.split_whitespace();
    let label = it.next()?;
    let digits = label.strip_prefix("pp")?;
    if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let nums: Vec<f64> = it.filter_map(|s| s.parse::<f64>().ok()).collect();
    if nums.len() < 4 {
        return None;
    }
    Some(HipfireBenchStatRow {
        label: label.to_string(),
        mean: nums[0],
        min: nums[1],
        max: nums[2],
        stdev: nums[3],
        ms: nums.get(4).copied(),
    })
}

const SUMMARY_LABELS: &[&str] = &["Prefill", "TTFT", "Decode", "Wall"];

/// A named summary row: `TTFT     ms          73.6     73.6     73.6      0.0`
/// → label, unit (skipped), mean, min, max, stdev. Any trailing free text
/// (e.g. `"(user prompt, 22 tok)"`) is ignored — only the first 4 numeric
/// tokens after the unit are read.
fn parse_summary_row(trimmed: &str) -> Option<HipfireBenchStatRow> {
    let mut it = trimmed.split_whitespace();
    let label = it.next()?;
    if !SUMMARY_LABELS.contains(&label) {
        return None;
    }
    it.next()?; // unit ("tok/s" | "ms") — not stored, the label already implies it
    let nums: Vec<f64> = it.filter_map(|s| s.parse::<f64>().ok()).take(4).collect();
    if nums.len() < 4 {
        return None;
    }
    Some(HipfireBenchStatRow {
        label: label.to_string(),
        mean: nums[0],
        min: nums[1],
        max: nums[2],
        stdev: nums[3],
        ms: None,
    })
}

/// `"Decode ms/tok: 12.20"` → `12.20`.
fn parse_decode_ms_per_tok(output: &str) -> Option<f64> {
    for line in output.lines() {
        if let Some(rest) = line.trim().strip_prefix("Decode ms/tok:") {
            if let Ok(v) = rest.trim().parse::<f64>() {
                return Some(v);
            }
        }
    }
    None
}

/// Parse `hipfire bench`'s text output into a structured summary. Pure — no
/// process spawning — unit-tested against the exact live-captured fixture
/// (2026-07-19, fact 1). Header fields are matched by exact `"<key>:"` prefix
/// anywhere in the output (order-independent), so a garbled or reordered
/// capture still parses whatever fields are present. Returns `None` only when
/// NOTHING recognisable was found (pure garbage/empty input) — a truncated
/// capture that still carries a partial header or table returns `Some` with
/// whatever fields were recovered, never panicking either way.
pub fn parse_hipfire_bench_summary(output: &str) -> Option<HipfireBenchSummary> {
    let mut header = HipfireBenchHeader::default();
    let mut prefill = Vec::new();
    let mut summary = Vec::new();

    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(v) = parse_kv_line(trimmed, "model") {
            header.model = Some(v);
            continue;
        }
        if let Some(v) = parse_kv_line(trimmed, "arch") {
            header.arch = Some(v);
            continue;
        }
        if let Some(v) = parse_kv_line(trimmed, "gpu") {
            header.gpu = Some(v);
            continue;
        }
        if let Some(v) = parse_kv_line(trimmed, "kv_cache") {
            header.kv_cache = Some(v);
            continue;
        }
        if let Some(v) = parse_kv_line(trimmed, "max_seq") {
            header.max_seq = Some(v);
            continue;
        }
        if let Some(v) = parse_kv_line(trimmed, "vram") {
            header.vram = Some(v);
            continue;
        }
        if let Some(v) = parse_kv_line(trimmed, "runs") {
            header.runs = Some(v);
            continue;
        }
        if let Some(v) = parse_kv_line(trimmed, "mode") {
            header.mode = Some(v);
            continue;
        }
        if let Some(row) = parse_prefill_row(trimmed) {
            prefill.push(row);
            continue;
        }
        if let Some(row) = parse_summary_row(trimmed) {
            summary.push(row);
            continue;
        }
    }

    let decode_ms_per_tok = parse_decode_ms_per_tok(output);

    if header == HipfireBenchHeader::default()
        && prefill.is_empty()
        && summary.is_empty()
        && decode_ms_per_tok.is_none()
    {
        return None;
    }

    Some(HipfireBenchSummary {
        header,
        prefill,
        summary,
        decode_ms_per_tok,
    })
}

// ── Command ──────────────────────────────────────────────────────────────

#[tauri::command]
pub fn run_hipfire_bench(
    app: AppHandle,
    state: State<'_, HipfireBenchState>,
    hipfire_path: String,
    tag: String,
    runs: u32,
) -> Result<u64, String> {
    if lock_or_poisoned(&state.child).is_some() {
        return Err("a benchmark is already running".into());
    }
    let exe = resolve_hipfire_bin(&hipfire_path)?;
    if tag.trim().is_empty() {
        return Err("a model tag to benchmark is required".into());
    }
    let runs = runs.max(1);

    let argv = vec![
        "bench".to_string(),
        tag.clone(),
        "--runs".to_string(),
        runs.to_string(),
    ];
    state.cancel.store(false, Ordering::SeqCst);
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    info!(
        "run_hipfire_bench: gen {generation} exe={} args={}",
        exe.display(),
        argv.join(" ")
    );

    let work_dir = exe
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    let mut child = quiet_command(&exe)
        .args(&argv)
        .current_dir(&work_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            error!("run_hipfire_bench: spawn failed: {e}");
            format!("spawn hipfire: {e}")
        })?;

    let stdout_pipe = child.stdout.take().ok_or("no stdout pipe")?;
    let stderr_pipe = child.stderr.take().ok_or("no stderr pipe")?;
    *lock_or_poisoned(&state.child) = Some(child);

    // Both streams → progress events AND the shared captured-output buffer the
    // reaper thread parses once the child exits.
    let captured = Arc::new(Mutex::new(String::new()));

    fn spawn_progress_pump<R: Read + Send + 'static>(
        app: AppHandle,
        gen_arc: Arc<AtomicU64>,
        generation: u64,
        reader: R,
        captured: Arc<Mutex<String>>,
    ) {
        std::thread::spawn(move || {
            let buf = BufReader::new(reader);
            for line in buf.lines().map_while(Result::ok) {
                if gen_arc.load(Ordering::SeqCst) != generation {
                    break;
                }
                {
                    let mut c = lock_or_poisoned(&captured);
                    c.push_str(&line);
                    c.push('\n');
                }
                if line.trim().is_empty() {
                    continue;
                }
                let _ = app.emit(
                    "hipfire-bench-progress",
                    HipfireBenchProgressEvent { generation, line },
                );
            }
        });
    }
    spawn_progress_pump(
        app.clone(),
        state.generation.clone(),
        generation,
        stdout_pipe,
        captured.clone(),
    );
    spawn_progress_pump(
        app.clone(),
        state.generation.clone(),
        generation,
        stderr_pipe,
        captured.clone(),
    );

    // Reap the child on a dedicated thread and emit the terminal event — the
    // SOLE emitter of `hipfire-bench-done`, always emitted exactly once, so
    // the UI can never be left stuck "running". Mirrors hipfire_pull.rs's
    // generation-aware poll loop.
    {
        let app = app.clone();
        let child_arc = state.child.clone();
        let cancel = state.cancel.clone();
        let gen_counter = state.generation.clone();
        std::thread::spawn(move || {
            let exit_ok = loop {
                std::thread::sleep(std::time::Duration::from_millis(200));
                if gen_counter.load(Ordering::SeqCst) != generation {
                    break None;
                }
                let mut slot = lock_or_poisoned(&child_arc);
                let Some(c) = slot.as_mut() else {
                    break Some(false);
                };
                match c.try_wait() {
                    Ok(Some(status)) => {
                        *slot = None;
                        break Some(status.success());
                    }
                    Ok(None) => continue,
                    Err(_) => {
                        *slot = None;
                        break Some(false);
                    }
                }
            };

            let output = lock_or_poisoned(&captured).clone();
            let summary = parse_hipfire_bench_summary(&output);

            let done = if exit_ok.is_none() || cancel.load(Ordering::SeqCst) {
                HipfireBenchDoneEvent {
                    generation,
                    ok: false,
                    cancelled: true,
                    error: None,
                    tag: tag.clone(),
                    output,
                    summary,
                }
            } else if exit_ok == Some(true) {
                HipfireBenchDoneEvent {
                    generation,
                    ok: true,
                    cancelled: false,
                    error: None,
                    tag: tag.clone(),
                    output,
                    summary,
                }
            } else {
                HipfireBenchDoneEvent {
                    generation,
                    ok: false,
                    cancelled: false,
                    error: Some("hipfire bench exited with an error — check the logs".into()),
                    tag: tag.clone(),
                    output,
                    summary,
                }
            };
            info!(
                "run_hipfire_bench: gen {generation} done ok={} cancelled={}",
                done.ok, done.cancelled
            );
            let _ = app.emit("hipfire-bench-done", done);
        });
    }

    Ok(generation)
}

#[tauri::command]
pub fn cancel_hipfire_bench(state: State<'_, HipfireBenchState>) -> Result<(), String> {
    state.cancel.store(true, Ordering::SeqCst);
    state.generation.fetch_add(1, Ordering::SeqCst);
    let mut slot = lock_or_poisoned(&state.child);
    if let Some(mut c) = slot.take() {
        // A bench holds the model resident in VRAM (~15GB for the fact-1
        // fixture) via the same `.cmd` shim -> cmd.exe -> bun.exe chain as
        // serve/pull/quantize — always tree-kill (see kill_child_tree).
        kill_child_tree(&mut c, true);
        info!("cancel_hipfire_bench: killed running benchmark");
    } else {
        debug!("cancel_hipfire_bench: nothing running");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Verbatim capture from `hipfire bench qwen3.6:27b --runs 1` (exit 0),
    // 2026-07-19 live capture, fact 1 — box-drawing separators reproduced as
    // plain dashes here (the parser doesn't rely on the separator glyphs at
    // all, only on the shape of the data rows).
    const FIXTURE: &str = "hipfire bench\n\
  model:     qwen3.6-27b.mq4  [qwen3_5]\n\
  arch:      dim=5120, layers=64, vocab=248320\n\
  gpu:       gfx1201  (HIP 7.13)\n\
  kv_cache:  auto\n\
  max_seq:   32768\n\
  vram:      25712 MB loaded  (6761/32624 MB free)\n\
  runs:      1\n\
  prompt:    \"Explain the theory of general relativity in simple terms.\"\n\
  mode:      standard\n\
  loading layer 1/64 (LinearAttention)...\n\
  loading layer 64/64 (LinearAttention)...\n\
KV cache: q8 quantized\n\
DFlash draft loaded: qwen36-27b-dflash-mq4.hfq\n\
  prefill: pp128=823 pp512=797 pp1024=769 pp2048=721\n\
  run 1/1 ... pp 299 tok/s | TTFT 74 ms | decode 82.0 tok/s (128 tok)\n\
\n\
  Prefill    tok/s      mean      min      max    stdev     ms\n\
  ----------------------------------------------------------------\n\
  pp128               822.7    822.7    822.7      0.0   155.6\n\
  pp512               797.2    797.2    797.2      0.0   642.3\n\
  pp1024              768.8    768.8    768.8      0.0   1332.0\n\
  pp2048              720.5    720.5    720.5      0.0   2842.6\n\
\n\
                       mean      min      max    stdev\n\
  ------------------------------------------------------\n\
  Prefill  tok/s      299.1    299.1    299.1      0.0   (user prompt, 22 tok)\n\
  TTFT     ms          73.6     73.6     73.6      0.0\n\
  Decode   tok/s       82.0     82.0     82.0      0.0\n\
  Wall     tok/s       78.3     78.3     78.3      0.0\n\
\n\
  Decode ms/tok: 12.20\n";

    #[test]
    fn parses_the_live_captured_fixture_header() {
        let s = parse_hipfire_bench_summary(FIXTURE).expect("fixture parses");
        let h = &s.header;
        assert!(h.model.as_deref().unwrap().contains("qwen3.6-27b.mq4"));
        assert!(h.model.as_deref().unwrap().contains("qwen3_5"));
        assert!(h.arch.as_deref().unwrap().contains("dim=5120"));
        assert!(h.arch.as_deref().unwrap().contains("layers=64"));
        assert!(h.gpu.as_deref().unwrap().contains("gfx1201"));
        assert_eq!(h.kv_cache.as_deref(), Some("auto"));
        assert_eq!(h.max_seq.as_deref(), Some("32768"));
        assert!(h.vram.as_deref().unwrap().contains("25712 MB loaded"));
        assert_eq!(h.runs.as_deref(), Some("1"));
        assert_eq!(h.mode.as_deref(), Some("standard"));
    }

    #[test]
    fn parses_the_prefill_sweep_rows() {
        let s = parse_hipfire_bench_summary(FIXTURE).unwrap();
        assert_eq!(
            s.prefill,
            vec![
                HipfireBenchStatRow {
                    label: "pp128".into(),
                    mean: 822.7,
                    min: 822.7,
                    max: 822.7,
                    stdev: 0.0,
                    ms: Some(155.6),
                },
                HipfireBenchStatRow {
                    label: "pp512".into(),
                    mean: 797.2,
                    min: 797.2,
                    max: 797.2,
                    stdev: 0.0,
                    ms: Some(642.3),
                },
                HipfireBenchStatRow {
                    label: "pp1024".into(),
                    mean: 768.8,
                    min: 768.8,
                    max: 768.8,
                    stdev: 0.0,
                    ms: Some(1332.0),
                },
                HipfireBenchStatRow {
                    label: "pp2048".into(),
                    mean: 720.5,
                    min: 720.5,
                    max: 720.5,
                    stdev: 0.0,
                    ms: Some(2842.6),
                },
            ]
        );
    }

    #[test]
    fn parses_the_decode_ttft_wall_summary_rows_and_ms_per_tok() {
        let s = parse_hipfire_bench_summary(FIXTURE).unwrap();
        assert_eq!(
            s.summary,
            vec![
                HipfireBenchStatRow {
                    label: "Prefill".into(),
                    mean: 299.1,
                    min: 299.1,
                    max: 299.1,
                    stdev: 0.0,
                    ms: None,
                },
                HipfireBenchStatRow {
                    label: "TTFT".into(),
                    mean: 73.6,
                    min: 73.6,
                    max: 73.6,
                    stdev: 0.0,
                    ms: None,
                },
                HipfireBenchStatRow {
                    label: "Decode".into(),
                    mean: 82.0,
                    min: 82.0,
                    max: 82.0,
                    stdev: 0.0,
                    ms: None,
                },
                HipfireBenchStatRow {
                    label: "Wall".into(),
                    mean: 78.3,
                    min: 78.3,
                    max: 78.3,
                    stdev: 0.0,
                    ms: None,
                },
            ]
        );
        assert_eq!(s.decode_ms_per_tok, Some(12.20));
    }

    #[test]
    fn empty_output_yields_none() {
        assert!(parse_hipfire_bench_summary("").is_none());
    }

    #[test]
    fn pure_garbage_input_yields_none_without_panicking() {
        let garbage = "not even close to hipfire bench output\n???\n\t\t\n12345\n";
        assert!(parse_hipfire_bench_summary(garbage).is_none());
    }

    #[test]
    fn truncated_input_yields_a_partial_summary_without_panicking() {
        // Only the header made it through (e.g. the child was killed mid-run
        // before any table printed) — must still parse what's there instead
        // of returning None outright.
        let truncated = "hipfire bench\n  model:     qwen3.6-27b.mq4  [qwen3_5]\n  runs:      1\n";
        let s = parse_hipfire_bench_summary(truncated).expect("partial header still parses");
        assert!(s.header.model.is_some());
        assert_eq!(s.header.runs.as_deref(), Some("1"));
        assert!(s.header.gpu.is_none());
        assert!(s.prefill.is_empty());
        assert!(s.summary.is_empty());
        assert!(s.decode_ms_per_tok.is_none());
    }

    #[test]
    fn unsupported_summary_label_is_ignored() {
        // A line shaped like a summary row but with an unrecognised label
        // must not be picked up as one.
        assert!(parse_summary_row("Bogus  tok/s  1.0  1.0  1.0  0.0").is_none());
    }

    #[test]
    fn prefill_row_rejects_non_pp_prefixed_labels() {
        assert!(parse_prefill_row("tg128  1.0  1.0  1.0  0.0  1.0").is_none());
        assert!(parse_prefill_row("pp  1.0  1.0  1.0  0.0  1.0").is_none());
        assert!(parse_prefill_row("ppabc  1.0  1.0  1.0  0.0  1.0").is_none());
    }
}
