//! `llama-bench` integration: run throughput benchmarks, stream progress, and
//! persist a history of runs so the user can compare quants / configs.
//!
//! Mirrors `server.rs`: a sync command spawns the child, hands the pipes to
//! detached pump threads, and returns immediately. The child lives in a shared
//! `Arc<Mutex<Option<Child>>>` so `cancel_bench` can kill it from the main
//! thread while the stdout-reader thread waits on it. A generation counter
//! (bumped on every run / cancel) ensures a superseded or cancelled run never
//! emits a stale `bench-done`.
//!
//! `llama-bench` writes its JSON result array to STDOUT and progress / warnings
//! to STDERR, so we parse STDOUT only and forward STDERR lines as progress.
//! It has no draft-model / speculative support, so MTP-on-vs-off comparison is
//! out of scope here (that needs the running server's `/v1` timings).

use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::Child;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use log::{debug, error, info, warn};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::build_scan::{quiet_command, resolve_bin_dir};
use crate::util::lock_or_poisoned;

/// Managed state for the (single) in-flight benchmark.
pub struct BenchState {
    /// The running `llama-bench` child, if any. Shared with the worker thread
    /// via `Arc` so the thread can reap it after EOF while `cancel_bench` can
    /// kill it from the command thread.
    pub child: Arc<Mutex<Option<Child>>>,
    /// Bumped once per `run_bench`. Stamped on `bench-done` so the frontend can
    /// drop an event from a superseded run.
    pub generation: Arc<AtomicU64>,
    /// Set by `cancel_bench` before it kills the child; read by the worker so it
    /// reports the run as cancelled rather than as a parse failure. Reset at the
    /// start of every run. This keeps the worker the SOLE emitter of
    /// `bench-done`, which avoids a race where neither cancel nor a reaping
    /// worker emits and the UI is stuck "running".
    pub cancel: Arc<AtomicBool>,
}

impl BenchState {
    pub fn new() -> Self {
        Self {
            child: Arc::new(Mutex::new(None)),
            generation: Arc::new(AtomicU64::new(0)),
            cancel: Arc::new(AtomicBool::new(false)),
        }
    }
}

impl Default for BenchState {
    fn default() -> Self {
        Self::new()
    }
}

/// One result row from `llama-bench -o json`. `#[serde(default)]` keeps parsing
/// resilient across llama.cpp versions (the schema grows over time); we only
/// rely on a stable subset. Field names match the JSON exactly — note `type_k`/
/// `type_v` (not `cache_type_*`), `flash_attn` is an int (0/1/2), and the size
/// fields are large integers.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BenchRow {
    pub model_filename: String,
    pub model_type: String,
    pub model_size: u64,
    pub model_n_params: u64,
    pub build_commit: String,
    pub test_time: String,
    pub n_prompt: u32,
    pub n_gen: u32,
    pub n_depth: u32,
    pub n_gpu_layers: i32,
    pub n_batch: u32,
    pub n_ubatch: u32,
    pub n_threads: u32,
    pub flash_attn: i32,
    pub type_k: String,
    pub type_v: String,
    pub avg_ns: u64,
    pub stddev_ns: u64,
    pub avg_ts: f64,
    pub stddev_ts: f64,
}

/// A persisted benchmark run (saved to `bench_runs.json`). Built and labelled
/// on the frontend, round-tripped here.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BenchRun {
    pub id: String,
    pub created_at: i64,
    pub model_path: String,
    pub label: String,
    pub rows: Vec<BenchRow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// Benchmark parameters from the frontend. Each matrix field is a comma-joined
/// string (e.g. "512,1024") passed straight to `llama-bench`, which expands it
/// into a benchmark matrix.
#[derive(Debug, Clone, Deserialize)]
pub struct BenchRequest {
    pub model: String,
    #[serde(default)]
    pub n_prompt: String,
    #[serde(default)]
    pub n_gen: String,
    #[serde(default)]
    pub n_gpu_layers: String,
    #[serde(default)]
    pub threads: String,
    #[serde(default)]
    pub batch: String,
    #[serde(default)]
    pub ubatch: String,
    #[serde(default)]
    pub cache_type_k: String,
    #[serde(default)]
    pub cache_type_v: String,
    #[serde(default)]
    pub flash_attn: String,
    #[serde(default)]
    pub reps: u32,
    /// Raw extra args appended verbatim — escape hatch for flags we don't model.
    #[serde(default)]
    pub extra: Vec<String>,
}

#[derive(Clone, Serialize)]
struct BenchProgressEvent {
    generation: u64,
    line: String,
}

#[derive(Clone, Serialize)]
struct BenchDoneEvent {
    generation: u64,
    ok: bool,
    cancelled: bool,
    error: Option<String>,
    rows: Vec<BenchRow>,
}

/// Assemble the `llama-bench` argv from a request. Uses llama-bench's own flag
/// spellings (`-m`, `-p`, `-n`, `-ngl`, `-t`, `-b`, `-ub`, `-ctk`, `-ctv`,
/// `-fa`, `-r`) — NOT the llama-server spellings `buildArgs` emits. The cache
/// types let the benchmark mirror the server's KV-cache quant (the Configure
/// tab's `-ctk`/`-ctv`), which materially moves throughput. Always appends
/// `-o json` and
/// `--progress` last so we get a parseable result array on stdout and progress
/// lines on stderr.
fn build_bench_argv(req: &BenchRequest) -> Vec<String> {
    let mut a: Vec<String> = Vec::new();
    let push_multi = |a: &mut Vec<String>, flag: &str, v: &str| {
        let v = v.trim();
        if !v.is_empty() {
            a.push(flag.to_string());
            a.push(v.to_string());
        }
    };
    push_multi(&mut a, "-m", &req.model);
    push_multi(&mut a, "-p", &req.n_prompt);
    push_multi(&mut a, "-n", &req.n_gen);
    push_multi(&mut a, "-ngl", &req.n_gpu_layers);
    push_multi(&mut a, "-t", &req.threads);
    push_multi(&mut a, "-b", &req.batch);
    push_multi(&mut a, "-ub", &req.ubatch);
    push_multi(&mut a, "-ctk", &req.cache_type_k);
    push_multi(&mut a, "-ctv", &req.cache_type_v);
    push_multi(&mut a, "-fa", &req.flash_attn);
    if req.reps > 0 {
        a.push("-r".into());
        a.push(req.reps.to_string());
    }
    a.extend(req.extra.iter().cloned());
    a.push("-o".into());
    a.push("json".into());
    a.push("--progress".into());
    a
}

/// Resolve the `llama-bench` executable inside a llama.cpp build directory,
/// using the same subdir probing as the server.
fn resolve_bench_exe(build_dir: &str) -> Result<PathBuf, String> {
    let exe_suffix = if cfg!(windows) { ".exe" } else { "" };
    let bin_dir = resolve_bin_dir(Path::new(build_dir));
    let exe = bin_dir.join(format!("llama-bench{exe_suffix}"));
    if !exe.is_file() {
        return Err(format!(
            "llama-bench not found at {} — build it with `cmake --build . --target llama-bench`",
            exe.to_string_lossy()
        ));
    }
    Ok(exe)
}

#[tauri::command]
pub fn run_bench(
    app: AppHandle,
    state: State<'_, BenchState>,
    build_dir: String,
    req: BenchRequest,
) -> Result<u64, String> {
    if lock_or_poisoned(&state.child).is_some() {
        return Err("a benchmark is already running".into());
    }
    if req.model.trim().is_empty() {
        return Err("no model selected".into());
    }
    if !PathBuf::from(&req.model).is_file() {
        return Err(format!("model file does not exist: {}", req.model));
    }

    let exe = resolve_bench_exe(&build_dir)?;
    let argv = build_bench_argv(&req);
    state.cancel.store(false, Ordering::SeqCst);
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    info!(
        "run_bench: gen {generation} exe={} args={}",
        exe.to_string_lossy(),
        argv.join(" ")
    );

    let mut child = quiet_command(&exe)
        .args(&argv)
        .current_dir(exe.parent().unwrap_or(Path::new(".")))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            error!("run_bench: spawn failed: {e}");
            format!("spawn llama-bench: {e}")
        })?;

    // Take pipes BEFORE the child moves into the shared slot (server.rs:172).
    let stdout_pipe = child.stdout.take().ok_or("no stdout pipe")?;
    let stderr_pipe = child.stderr.take().ok_or("no stderr pipe")?;
    *lock_or_poisoned(&state.child) = Some(child);

    // STDERR → progress events. Exits on EOF (process death / pipe close).
    {
        let app = app.clone();
        let gen_arc = state.generation.clone();
        std::thread::spawn(move || {
            let buf = BufReader::new(stderr_pipe);
            for line in buf.lines().map_while(Result::ok) {
                if gen_arc.load(Ordering::SeqCst) != generation {
                    break;
                }
                if line.trim().is_empty() {
                    continue;
                }
                let _ = app.emit("bench-progress", BenchProgressEvent { generation, line });
            }
            debug!("bench stderr pump (gen {generation}) exited");
        });
    }

    // STDOUT → collect the JSON array, reap the child, parse, emit bench-done.
    // This thread is the SOLE emitter of `bench-done` and always emits exactly
    // once (the child's death — natural or via cancel — closes stdout and wakes
    // it), so the UI can never be left stuck on "running".
    {
        let app = app.clone();
        let child_arc = state.child.clone();
        let cancel = state.cancel.clone();
        std::thread::spawn(move || {
            let mut out = String::new();
            let _ = BufReader::new(stdout_pipe).read_to_string(&mut out);

            let exit_ok = {
                let mut slot = lock_or_poisoned(&child_arc);
                match slot.take() {
                    // Reap whatever child is in the slot. If cancel already took
                    // and killed it, this is None and we fall through to the
                    // cancelled branch below.
                    Some(mut c) => c.wait().map(|s| s.success()).unwrap_or(false),
                    None => false,
                }
            };

            let done = if cancel.load(Ordering::SeqCst) {
                BenchDoneEvent {
                    generation,
                    ok: false,
                    cancelled: true,
                    error: None,
                    rows: vec![],
                }
            } else {
                match serde_json::from_str::<Vec<BenchRow>>(out.trim()) {
                    Ok(rows) if !rows.is_empty() => BenchDoneEvent {
                        generation,
                        ok: true,
                        cancelled: false,
                        error: None,
                        rows,
                    },
                    Ok(_) => BenchDoneEvent {
                        generation,
                        ok: false,
                        cancelled: false,
                        error: Some(if exit_ok {
                            "llama-bench produced no result rows".into()
                        } else {
                            "llama-bench exited with an error — check the logs".into()
                        }),
                        rows: vec![],
                    },
                    Err(e) => {
                        warn!("run_bench: parse failed: {e}");
                        BenchDoneEvent {
                            generation,
                            ok: false,
                            cancelled: false,
                            error: Some(format!(
                                "could not parse llama-bench output: {e}{}",
                                if exit_ok {
                                    ""
                                } else {
                                    " (llama-bench exited with an error — check the logs)"
                                }
                            )),
                            rows: vec![],
                        }
                    }
                }
            };
            info!(
                "run_bench: gen {generation} done ok={} cancelled={} rows={}",
                done.ok,
                done.cancelled,
                done.rows.len()
            );
            let _ = app.emit("bench-done", done);
        });
    }

    Ok(generation)
}

#[tauri::command]
pub fn cancel_bench(state: State<'_, BenchState>) -> Result<(), String> {
    // Signal cancellation BEFORE killing the child: killing closes its stdout,
    // which wakes the worker thread; it must see the flag already set so it
    // reports `cancelled` rather than a parse failure. The worker remains the
    // sole emitter of `bench-done`.
    state.cancel.store(true, Ordering::SeqCst);
    let mut slot = lock_or_poisoned(&state.child);
    if let Some(mut c) = slot.take() {
        let _ = c.kill();
        let _ = c.wait();
        info!("cancel_bench: killed running benchmark");
    } else {
        debug!("cancel_bench: nothing running");
    }
    Ok(())
}

fn bench_runs_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    Ok(dir.join("bench_runs.json"))
}

#[tauri::command]
pub fn load_bench_runs(app: AppHandle) -> Result<Vec<BenchRun>, String> {
    let p = bench_runs_path(&app)?;
    if !p.exists() {
        return Ok(Vec::new());
    }
    let s = fs::read_to_string(&p).map_err(|e| format!("read: {e}"))?;
    serde_json::from_str(&s).map_err(|e| format!("parse: {e}"))
}

#[tauri::command]
pub fn save_bench_runs(app: AppHandle, runs: Vec<BenchRun>) -> Result<(), String> {
    let p = bench_runs_path(&app)?;
    let s = serde_json::to_string(&runs).map_err(|e| format!("encode: {e}"))?;
    fs::write(&p, s).map_err(|e| format!("write: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req() -> BenchRequest {
        BenchRequest {
            model: "C:/models/m.gguf".into(),
            n_prompt: "512".into(),
            n_gen: "128".into(),
            n_gpu_layers: "999".into(),
            threads: "".into(),
            batch: "2048".into(),
            ubatch: "".into(),
            cache_type_k: "q8_0".into(),
            cache_type_v: "q8_0".into(),
            flash_attn: "on".into(),
            reps: 3,
            extra: vec![],
        }
    }

    #[test]
    fn argv_uses_bench_flag_spellings_and_forces_json() {
        let a = build_bench_argv(&req());
        let joined = a.join(" ");
        assert!(joined.contains("-m C:/models/m.gguf"));
        assert!(joined.contains("-p 512"));
        assert!(joined.contains("-n 128"));
        assert!(joined.contains("-ngl 999"));
        assert!(joined.contains("-b 2048"));
        assert!(joined.contains("-ctk q8_0"));
        assert!(joined.contains("-ctv q8_0"));
        assert!(joined.contains("-fa on"));
        assert!(joined.contains("-r 3"));
        // Empty fields are skipped entirely.
        assert!(!joined.contains("-t "));
        assert!(!joined.contains("-ub "));
        // JSON output + progress are always last.
        assert!(joined.ends_with("-o json --progress"));
    }

    #[test]
    fn argv_skips_reps_when_zero_and_appends_extra() {
        let mut r = req();
        r.reps = 0;
        r.extra = vec!["-ot".into(), "exps=CPU".into()];
        let a = build_bench_argv(&r);
        let joined = a.join(" ");
        assert!(!joined.contains("-r "));
        assert!(joined.contains("-ot exps=CPU"));
    }

    #[test]
    fn bench_row_parses_real_llama_bench_json() {
        // A pp row and a tg row as emitted by `llama-bench -o json`.
        let json = r#"[
          {"model_filename":"m.gguf","model_type":"qwen","model_size":27600000000,
           "model_n_params":27000000000,"build_commit":"10829dbc","test_time":"2026-06-14T00:00:00Z",
           "n_prompt":512,"n_gen":0,"n_depth":0,"n_gpu_layers":-1,"n_batch":2048,"n_ubatch":512,
           "n_threads":12,"flash_attn":1,"type_k":"f16","type_v":"f16",
           "avg_ns":1000000,"stddev_ns":1000,"avg_ts":512.5,"stddev_ts":1.2},
          {"model_filename":"m.gguf","n_prompt":0,"n_gen":128,"avg_ts":48.7,"stddev_ts":0.4,
           "flash_attn":1,"n_gpu_layers":-1}
        ]"#;
        let rows: Vec<BenchRow> = serde_json::from_str(json).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].n_prompt, 512);
        assert_eq!(rows[0].n_gen, 0);
        assert_eq!(rows[0].model_size, 27_600_000_000);
        assert!((rows[0].avg_ts - 512.5).abs() < 1e-6);
        // Missing fields fall back to defaults rather than failing the parse.
        assert_eq!(rows[1].n_gen, 128);
        assert_eq!(rows[1].n_batch, 0);
        assert_eq!(rows[1].type_k, "");
    }

    #[test]
    fn bench_run_roundtrips_and_tolerates_missing_note() {
        let json = r#"{"id":"r1","created_at":1,"model_path":"m.gguf","label":"x","rows":[]}"#;
        let run: BenchRun = serde_json::from_str(json).unwrap();
        assert!(run.note.is_none());
        let encoded = serde_json::to_string(&run).unwrap();
        // `note: None` is skipped on the way out.
        assert!(!encoded.contains("note"));
    }
}
