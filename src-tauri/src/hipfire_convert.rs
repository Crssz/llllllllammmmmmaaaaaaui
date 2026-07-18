//! `hipfire quantize` integration: convert a `.gguf` into hipfire's own store
//! (`hf4`/`mq4`) and register it under a tag `hipfire serve <tag>` can load.
//!
//! Mirrors `bench.rs`'s process-orchestration pattern: a sync command spawns
//! the child, hands the pipes to detached pump threads, and returns
//! immediately. The child lives in a shared `Arc<Mutex<Option<Child>>>` so
//! `cancel_hipfire_convert` can kill it from the main thread while the
//! stdout-reader thread waits on it. A generation counter (bumped on every
//! run / cancel) ensures a superseded or cancelled run never emits a stale
//! `hipfire-convert-done`.
//!
//! hipfire's quantizer panics on source quant types it doesn't implement
//! (IQ-quants, Q5_0/Q5_1, Q2_K/Q3_K), so we pre-check the GGUF's tensor types
//! via `gguf::inspect_gguf` and refuse with a clear error instead of letting
//! the child crash.

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
use crate::gguf::inspect_gguf;
use crate::util::lock_or_poisoned;

/// ggml quant types hipfire's quantizer can convert. Anything outside this
/// set (IQ-quants, Q5_0/Q5_1, Q2_K/Q3_K, and any type we don't recognise)
/// panics the child process rather than erroring cleanly — see the plan's
/// Phase 2 quantizer-gaps note.
const SUPPORTED_SOURCE_TYPES: &[&str] =
    &["Q4_0", "Q8_0", "Q4_K", "Q5_K", "Q6_K", "F16", "BF16", "F32"];

/// Managed state for the (single) in-flight conversion.
pub struct HipfireConvertState {
    pub child: Arc<Mutex<Option<Child>>>,
    pub generation: Arc<AtomicU64>,
    pub cancel: Arc<AtomicBool>,
}

impl HipfireConvertState {
    pub fn new() -> Self {
        Self {
            child: Arc::new(Mutex::new(None)),
            generation: Arc::new(AtomicU64::new(0)),
            cancel: Arc::new(AtomicBool::new(false)),
        }
    }
}

impl Default for HipfireConvertState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Serialize)]
struct HipfireConvertProgressEvent {
    generation: u64,
    line: String,
}

#[derive(Clone, Serialize)]
struct HipfireConvertDoneEvent {
    generation: u64,
    ok: bool,
    cancelled: bool,
    error: Option<String>,
    tag: String,
}

/// Return the tensor types in `types` that hipfire's quantizer can't convert,
/// or an empty vec when every type is supported (or the tensor table couldn't
/// be read at all — treated as "unknown", not blocked, so a best-effort GGUF
/// read failure never wrongly refuses a convertible model).
fn unsupported_types(types: &[String]) -> Vec<String> {
    types
        .iter()
        .filter(|t| !SUPPORTED_SOURCE_TYPES.contains(&t.as_str()))
        .cloned()
        .collect()
}

#[tauri::command]
pub fn hipfire_convert(
    app: AppHandle,
    state: State<'_, HipfireConvertState>,
    hipfire_path: String,
    gguf_path: String,
    format: String,
    tag: String,
) -> Result<u64, String> {
    if lock_or_poisoned(&state.child).is_some() {
        return Err("a conversion is already running".into());
    }
    // Same resolution as the server launch path: an explicit path wins when
    // it exists, otherwise fall back to the `hipfire` CLI on PATH / the
    // canonical `~/.hipfire/bin` install dir, so quantize also works without
    // the user having browsed to an exe.
    let exe = crate::server::resolve_hipfire_bin(&hipfire_path)?;
    if gguf_path.trim().is_empty() || !PathBuf::from(&gguf_path).is_file() {
        return Err(format!("GGUF file does not exist: {gguf_path}"));
    }
    if tag.trim().is_empty() {
        return Err("a tag to register the converted model under is required".into());
    }
    let format = if format.trim().is_empty() {
        "hf4".to_string()
    } else {
        format
    };

    // Pre-flight: refuse cleanly on source quants hipfire's quantizer panics
    // on, rather than letting the child crash mid-conversion.
    let info = inspect_gguf(gguf_path.clone())?;
    let bad = unsupported_types(&info.tensor_types);
    if !bad.is_empty() {
        return Err(format!(
            "{} uses quant type(s) hipfire's quantizer can't convert: {}. Supported source \
             types: {}. Re-quantize to a supported type first (Q6_K/Q8_0 recommended — GGUF → \
             hipfire is already a lossy double-quantization).",
            gguf_path,
            bad.join(", "),
            SUPPORTED_SOURCE_TYPES.join(", "),
        ));
    }

    let argv = vec![
        "quantize".to_string(),
        gguf_path.clone(),
        "--format".to_string(),
        format,
        "--install".to_string(),
        "--register".to_string(),
        tag.clone(),
    ];
    state.cancel.store(false, Ordering::SeqCst);
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    info!(
        "hipfire_convert: gen {generation} exe={} args={}",
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
            error!("hipfire_convert: spawn failed: {e}");
            format!("spawn hipfire: {e}")
        })?;

    // Take pipes BEFORE the child moves into the shared slot (server.rs pattern).
    let stdout_pipe = child.stdout.take().ok_or("no stdout pipe")?;
    let stderr_pipe = child.stderr.take().ok_or("no stderr pipe")?;
    *lock_or_poisoned(&state.child) = Some(child);

    // Both streams → progress events (quantize logs go to either, depending on
    // build). Each pump exits on EOF (process death / pipe close).
    fn spawn_progress_pump<R: Read + Send + 'static>(
        app: AppHandle,
        gen_arc: Arc<AtomicU64>,
        generation: u64,
        reader: R,
    ) {
        std::thread::spawn(move || {
            let buf = BufReader::new(reader);
            for line in buf.lines().map_while(Result::ok) {
                if gen_arc.load(Ordering::SeqCst) != generation {
                    break;
                }
                if line.trim().is_empty() {
                    continue;
                }
                let _ = app.emit(
                    "hipfire-convert-progress",
                    HipfireConvertProgressEvent { generation, line },
                );
            }
        });
    }
    spawn_progress_pump(
        app.clone(),
        state.generation.clone(),
        generation,
        stdout_pipe,
    );
    spawn_progress_pump(
        app.clone(),
        state.generation.clone(),
        generation,
        stderr_pipe,
    );

    // Reap the child on a dedicated thread and emit the terminal event. This
    // thread is the SOLE emitter of `hipfire-convert-done`, always emits
    // exactly once, so the UI can never be left stuck "running".
    {
        let app = app.clone();
        let child_arc = state.child.clone();
        let cancel = state.cancel.clone();
        std::thread::spawn(move || {
            // Poll for exit rather than blocking wait(), since the stdout/stderr
            // pumps above already own the pipes and this thread doesn't have a
            // reader to block on for EOF.
            let exit_ok = loop {
                std::thread::sleep(std::time::Duration::from_millis(200));
                let mut slot = lock_or_poisoned(&child_arc);
                let Some(c) = slot.as_mut() else {
                    // Already reaped/killed by cancel_hipfire_convert.
                    break false;
                };
                match c.try_wait() {
                    Ok(Some(status)) => {
                        *slot = None;
                        break status.success();
                    }
                    Ok(None) => continue,
                    Err(_) => {
                        *slot = None;
                        break false;
                    }
                }
            };

            let done = if cancel.load(Ordering::SeqCst) {
                HipfireConvertDoneEvent {
                    generation,
                    ok: false,
                    cancelled: true,
                    error: None,
                    tag: tag.clone(),
                }
            } else if exit_ok {
                HipfireConvertDoneEvent {
                    generation,
                    ok: true,
                    cancelled: false,
                    error: None,
                    tag: tag.clone(),
                }
            } else {
                HipfireConvertDoneEvent {
                    generation,
                    ok: false,
                    cancelled: false,
                    error: Some("hipfire quantize exited with an error — check the logs".into()),
                    tag: tag.clone(),
                }
            };
            info!(
                "hipfire_convert: gen {generation} done ok={} cancelled={}",
                done.ok, done.cancelled
            );
            let _ = app.emit("hipfire-convert-done", done);
        });
    }

    Ok(generation)
}

#[tauri::command]
pub fn cancel_hipfire_convert(state: State<'_, HipfireConvertState>) -> Result<(), String> {
    state.cancel.store(true, Ordering::SeqCst);
    let mut slot = lock_or_poisoned(&state.child);
    if let Some(mut c) = slot.take() {
        // `hipfire quantize` runs through the same `.cmd` shim as `serve` —
        // spawning it launches `cmd.exe`, which spawns the actual `bun.exe`
        // doing the conversion. A plain kill only reaps the top `cmd.exe` and
        // can orphan `bun.exe` mid-conversion (see kill_child_tree / the
        // 2026-07-18 live-verification cmd->bun orphan proof), so always
        // tree-kill here rather than gating on an engine toggle — this
        // command only ever spawns hipfire.
        crate::server::kill_child_tree(&mut c, true);
        info!("cancel_hipfire_convert: killed running conversion");
    } else {
        debug!("cancel_hipfire_convert: nothing running");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_types_flags_iq_and_banned_k_quants() {
        let bad = unsupported_types(&[
            "Q4_K".to_string(),
            "IQ2_XS".to_string(),
            "Q2_K".to_string(),
            "Q5_0".to_string(),
        ]);
        assert_eq!(bad, vec!["IQ2_XS", "Q2_K", "Q5_0"]);
    }

    #[test]
    fn unsupported_types_empty_when_all_supported() {
        let bad = unsupported_types(&[
            "Q4_0".to_string(),
            "Q8_0".to_string(),
            "Q4_K".to_string(),
            "Q5_K".to_string(),
            "Q6_K".to_string(),
            "F16".to_string(),
            "BF16".to_string(),
            "F32".to_string(),
        ]);
        assert!(bad.is_empty());
    }

    #[test]
    fn unsupported_types_empty_for_empty_input() {
        assert!(unsupported_types(&[]).is_empty());
    }

    #[test]
    fn unsupported_types_treats_unknown_type_ids_as_unsupported() {
        // TYPE_<id> (an id ggml_type_name doesn't recognise) is conservatively
        // treated as unsupported rather than silently allowed through.
        let bad = unsupported_types(&["TYPE_101".to_string()]);
        assert_eq!(bad, vec!["TYPE_101"]);
    }
}
