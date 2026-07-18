//! `hipfire pull` integration: browse hipfire's curated remote model catalog
//! (`hipfire list -r`) and pull a tag from HuggingFace into hipfire's local
//! store (`hipfire pull <tag>`).
//!
//! Mirrors `hipfire_convert.rs`'s process-orchestration pattern: a sync
//! command spawns the child, hands the pipes to detached pump threads, and
//! returns immediately. The child lives in a shared `Arc<Mutex<Option<Child>>>`
//! so `cancel_hipfire_pull` can kill it from the main thread while the
//! stdout-reader thread waits on it. A generation counter (bumped on every
//! run / cancel) ensures a superseded or cancelled run never emits a stale
//! `hipfire-pull-done`.
//!
//! `hipfire pull`'s output is progress spam (download bars etc.), not
//! structured data, so it's streamed to the frontend raw, line-by-line — no
//! parsing there, unlike `list_hipfire_available` below.

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

/// Managed state for the (single) in-flight pull.
pub struct HipfirePullState {
    pub child: Arc<Mutex<Option<Child>>>,
    pub generation: Arc<AtomicU64>,
    pub cancel: Arc<AtomicBool>,
}

impl HipfirePullState {
    pub fn new() -> Self {
        Self {
            child: Arc::new(Mutex::new(None)),
            generation: Arc::new(AtomicU64::new(0)),
            cancel: Arc::new(AtomicBool::new(false)),
        }
    }
}

impl Default for HipfirePullState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Serialize)]
struct HipfirePullProgressEvent {
    generation: u64,
    line: String,
}

#[derive(Clone, Serialize)]
struct HipfirePullDoneEvent {
    generation: u64,
    ok: bool,
    cancelled: bool,
    error: Option<String>,
    tag: String,
}

/// One entry in hipfire's curated pull catalog (`hipfire list -r`'s
/// "Available models:" section).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct HipfireAvailableModel {
    pub tag: String,
    pub size: String,
    pub note: String,
    /// True when `note` carries the "[downloaded]" suffix `hipfire list -r`
    /// appends to tags already present locally.
    pub downloaded: bool,
}

/// Parse the "Available models:" section of `hipfire list -r` output. Pure —
/// no process spawning — so it's unit-testable against the exact
/// live-captured fixture (live-verification-checklist.md, 2026-07-18
/// re-verification). Line shape: two-space indent, TAG (first
/// whitespace-delimited token), SIZE (second token, e.g. "0.55GB"/"82GB"),
/// then a free-text NOTE occupying the rest of the line (may contain unicode
/// and many words, and — for locally-present tags — a trailing
/// "[downloaded]" marker). Any other top-level (non-indented, non-blank)
/// line ends the section. Returns an empty vec when the section is missing
/// or has no entries.
pub fn parse_hipfire_available(output: &str) -> Vec<HipfireAvailableModel> {
    let mut models = Vec::new();
    let mut in_section = false;
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed == "Available models:" {
            in_section = true;
            continue;
        }
        if !in_section || trimmed.is_empty() {
            continue;
        }
        if !line.starts_with(' ') {
            in_section = false;
            continue;
        }
        let mut parts = trimmed.split_whitespace();
        let (Some(tag), Some(size)) = (parts.next(), parts.next()) else {
            continue;
        };
        // Reconstructing the note by re-joining the remaining whitespace-split
        // tokens with single spaces collapses the fixture's multi-space
        // column padding, but preserves every word (and the "[downloaded]"
        // marker) — the only things callers care about.
        let note = parts.collect::<Vec<_>>().join(" ");
        let downloaded = note.contains("[downloaded]");
        models.push(HipfireAvailableModel {
            tag: tag.to_string(),
            size: size.to_string(),
            note,
            downloaded,
        });
    }
    models
}

/// Run `<hipfire> list -r` and parse its "Available models:" section — the
/// curated catalog `hipfire pull <tag>` can fetch from HuggingFace.
#[tauri::command]
pub fn list_hipfire_available(explicit: Option<String>) -> Result<Vec<HipfireAvailableModel>, String> {
    let bin = resolve_hipfire_bin(explicit.as_deref().unwrap_or(""))?;
    let work_dir = bin
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    let output = quiet_command(&bin)
        .args(["list", "-r"])
        .current_dir(&work_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("spawn hipfire list -r: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("hipfire list -r failed: {}", stderr.trim()));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_hipfire_available(&stdout))
}

#[tauri::command]
pub fn hipfire_pull(
    app: AppHandle,
    state: State<'_, HipfirePullState>,
    hipfire_path: String,
    tag: String,
) -> Result<u64, String> {
    if lock_or_poisoned(&state.child).is_some() {
        return Err("a pull is already running".into());
    }
    // Same resolution as every other hipfire-facing command: an explicit path
    // wins when it exists, otherwise fall back to the `hipfire` CLI on PATH /
    // the canonical `~/.hipfire/bin` install dir.
    let exe = resolve_hipfire_bin(&hipfire_path)?;
    if tag.trim().is_empty() {
        return Err("a tag to pull is required".into());
    }

    let argv = vec!["pull".to_string(), tag.clone()];
    state.cancel.store(false, Ordering::SeqCst);
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    info!(
        "hipfire_pull: gen {generation} exe={} args={}",
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
            error!("hipfire_pull: spawn failed: {e}");
            format!("spawn hipfire: {e}")
        })?;

    // Take pipes BEFORE the child moves into the shared slot (server.rs pattern).
    let stdout_pipe = child.stdout.take().ok_or("no stdout pipe")?;
    let stderr_pipe = child.stderr.take().ok_or("no stderr pipe")?;
    *lock_or_poisoned(&state.child) = Some(child);

    // Both streams → progress events, streamed raw (pull's output is
    // download-progress spam, not structured data — no parsing here). Each
    // pump exits on EOF (process death / pipe close).
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
                    "hipfire-pull-progress",
                    HipfirePullProgressEvent { generation, line },
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

    // Reap the child on a dedicated thread and emit the terminal event —
    // the SOLE emitter of `hipfire-pull-done`, always emitted exactly once,
    // so the UI can never be left stuck "running".
    {
        let app = app.clone();
        let child_arc = state.child.clone();
        let cancel = state.cancel.clone();
        std::thread::spawn(move || {
            let exit_ok = loop {
                std::thread::sleep(std::time::Duration::from_millis(200));
                let mut slot = lock_or_poisoned(&child_arc);
                let Some(c) = slot.as_mut() else {
                    // Already reaped/killed by cancel_hipfire_pull.
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
                HipfirePullDoneEvent {
                    generation,
                    ok: false,
                    cancelled: true,
                    error: None,
                    tag: tag.clone(),
                }
            } else if exit_ok {
                HipfirePullDoneEvent {
                    generation,
                    ok: true,
                    cancelled: false,
                    error: None,
                    tag: tag.clone(),
                }
            } else {
                HipfirePullDoneEvent {
                    generation,
                    ok: false,
                    cancelled: false,
                    error: Some("hipfire pull exited with an error — check the logs".into()),
                    tag: tag.clone(),
                }
            };
            info!(
                "hipfire_pull: gen {generation} done ok={} cancelled={}",
                done.ok, done.cancelled
            );
            let _ = app.emit("hipfire-pull-done", done);
        });
    }

    Ok(generation)
}

#[tauri::command]
pub fn cancel_hipfire_pull(state: State<'_, HipfirePullState>) -> Result<(), String> {
    state.cancel.store(true, Ordering::SeqCst);
    let mut slot = lock_or_poisoned(&state.child);
    if let Some(mut c) = slot.take() {
        // `hipfire pull` runs through the same `.cmd` shim as `serve`/
        // `quantize` — a plain kill only reaps the wrapping cmd.exe and can
        // orphan the bun.exe doing the actual download (see kill_child_tree /
        // the 2026-07-18 live-verification cmd->bun orphan proof). This
        // command only ever spawns hipfire, so tree-kill unconditionally.
        kill_child_tree(&mut c, true);
        info!("cancel_hipfire_pull: killed running pull");
    } else {
        debug!("cancel_hipfire_pull: nothing running");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_hipfire_available_reads_the_live_captured_fixture() {
        // Verbatim capture from `hipfire list -r`'s "Available models:"
        // section (live-verification-checklist.md, 2026-07-18
        // re-verification, fact 6) — includes the long multi-word deepseek
        // note and both "[downloaded]" lines.
        let output = "Available models:\n\n  \
            qwen3.5:0.8b            0.55GB  386 / 5100 tok/s\n  \
            qwen3.5:4b              2.59GB  169 / 1900 tok/s\n  \
            deepseek-v4-flash         82GB  DeepSeek V4 Flash, MQ2-Lloyd routed-expert MoE (arch_id=9). Includes MTP sidecar for K=2 spec-decode (+29% TG on code). temp=1.0 is safety-critical: greedy/low-temp falls into token loops on the quant.\n  \
            qwen3.6:27b               15GB  44 tok/s AR / 185 tok/s w/ draft on code [downloaded]\n  \
            qwen3.6:27b-draft       0.92GB  DFlash draft for qwen3.6:27b - pairs with target for ~4x decode on code (refreshed 2026-04-27 from z-lab@0919688) [downloaded]\n  \
            nex-n2:mini            19.82GB  Qwen3.5-35B-A3B agentic MoE (nex-agi, SWE-bench Verified 74.4). 88 tok/s. T3-3L graded experts (MQ6/MQ4/MQ3L). Tool-use: qwen3 reasoning / qwen3_coder tool-call format.\n";

        let models = parse_hipfire_available(output);
        assert_eq!(models.len(), 6);

        assert_eq!(models[0].tag, "qwen3.5:0.8b");
        assert_eq!(models[0].size, "0.55GB");
        assert_eq!(models[0].note, "386 / 5100 tok/s");
        assert!(!models[0].downloaded);

        let deepseek = &models[2];
        assert_eq!(deepseek.tag, "deepseek-v4-flash");
        assert_eq!(deepseek.size, "82GB");
        assert!(!deepseek.downloaded);
        assert!(deepseek.note.contains("DeepSeek V4 Flash"));
        assert!(deepseek.note.contains("MQ2-Lloyd routed-expert MoE"));
        assert!(deepseek.note.contains("temp=1.0 is safety-critical"));

        let target = &models[3];
        assert_eq!(target.tag, "qwen3.6:27b");
        assert_eq!(target.size, "15GB");
        assert!(target.downloaded);
        assert!(target.note.contains("[downloaded]"));

        let draft = &models[4];
        assert_eq!(draft.tag, "qwen3.6:27b-draft");
        assert_eq!(draft.size, "0.92GB");
        assert!(draft.downloaded);
        assert!(draft.note.contains("DFlash draft for qwen3.6:27b"));

        let nex = &models[5];
        assert_eq!(nex.tag, "nex-n2:mini");
        assert_eq!(nex.size, "19.82GB");
        assert!(!nex.downloaded);
    }

    #[test]
    fn parse_hipfire_available_empty_output_yields_empty_vec() {
        assert!(parse_hipfire_available("").is_empty());
    }

    #[test]
    fn parse_hipfire_available_missing_section_yields_empty_vec() {
        assert!(parse_hipfire_available("some unrelated CLI output\n").is_empty());
    }

    #[test]
    fn parse_hipfire_available_ignores_the_local_models_section() {
        // A combined `list -r` output must not leak "Local models:" rows
        // into the "Available models:" result.
        let output = "Local models:\n\n  qwen3.6-27b.mq4                     15.0GB (qwen3.6:27b)\n\nAvailable models:\n\n  qwen3.5:0.8b            0.55GB  386 / 5100 tok/s\n";
        let models = parse_hipfire_available(output);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].tag, "qwen3.5:0.8b");
    }
}
