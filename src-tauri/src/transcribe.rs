//! One-shot multimodal transcription via `llama-mtmd-cli`.
//!
//! Unlike `llama-server` (a long-lived HTTP service the chat UI talks to),
//! `llama-mtmd-cli` is invoked once per request: it loads the model + audio
//! projector, consumes a single `--audio` file plus a text prompt, streams the
//! generated transcription to **stdout**, prints load/encode progress to
//! **stderr**, and exits. We spawn it, pump both pipes to the frontend as
//! `mtmd-event`s (tagged with a generation id so the UI can drop stale output),
//! and reap it from a monitor thread that emits the terminal `done` event.

use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use log::{debug, error, info, warn};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::build_scan::{quiet_command, resolve_bin_dir};
use crate::util::{chrono_now_millis, lock_or_poisoned};

pub struct TranscribeState {
    /// Arc-wrapped so the monitor thread can reap the child after the spawning
    /// command returns. `cancel_transcribe` kills it via the same handle.
    pub child: Arc<Mutex<Option<Child>>>,
    /// Bumped on every start and every cancel. Pump/monitor threads carry the
    /// generation they were spawned for; the UI ignores any event whose `gen`
    /// no longer matches the active run, so output from a cancelled job can't
    /// bleed into the next one.
    pub run_gen: Arc<AtomicU64>,
}

impl TranscribeState {
    pub fn new() -> Self {
        Self {
            child: Arc::new(Mutex::new(None)),
            run_gen: Arc::new(AtomicU64::new(0)),
        }
    }
}

impl Default for TranscribeState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct TranscribeStarted {
    pub pid: u32,
    pub gen: u64,
    pub started_at: i64,
}

/// One streamed line / chunk from a running transcription. `kind` is one of
/// `"output"` (stdout, the transcription text), `"log"` (stderr progress), or
/// `"done"` (process exited — `code` carries the exit status when known).
#[derive(Debug, Clone, Serialize)]
struct MtmdEvent {
    gen: u64,
    kind: &'static str,
    text: String,
    code: Option<i32>,
}

/// Scan an argv list for the value following any of `flags`. Mirrors the
/// `--model` validation in `server::start_server`.
fn arg_value<'a>(args: &'a [String], flags: &[&str]) -> Option<&'a str> {
    let mut iter = args.iter();
    while let Some(a) = iter.next() {
        if flags.contains(&a.as_str()) {
            return iter.next().map(|s| s.as_str());
        }
    }
    None
}

/// Split a byte buffer into the longest valid UTF-8 prefix plus the leftover
/// tail to carry into the next read. A trailing *incomplete* multibyte
/// sequence is kept in the tail; genuinely *invalid* bytes are replaced with
/// U+FFFD and skipped so the tail can never get stuck.
fn split_valid_utf8(bytes: &[u8]) -> (String, Vec<u8>) {
    match std::str::from_utf8(bytes) {
        Ok(s) => (s.to_string(), Vec::new()),
        Err(e) => {
            let valid_up_to = e.valid_up_to();
            // SAFETY: from_utf8 just confirmed bytes[..valid_up_to] is valid.
            let head = unsafe { std::str::from_utf8_unchecked(&bytes[..valid_up_to]) }.to_string();
            match e.error_len() {
                // Incomplete tail — wait for more bytes.
                None => (head, bytes[valid_up_to..].to_vec()),
                // Invalid bytes — emit a replacement char and skip past them.
                Some(bad) => {
                    let mut out = head;
                    out.push('\u{FFFD}');
                    (out, bytes[valid_up_to + bad..].to_vec())
                }
            }
        }
    }
}

#[tauri::command]
pub fn transcribe_audio(
    app: AppHandle,
    state: State<'_, TranscribeState>,
    build_dir: String,
    args: Vec<String>,
) -> Result<TranscribeStarted, String> {
    info!(
        "transcribe_audio: build_dir={build_dir} args={}",
        args.join(" ")
    );

    let mut child_slot = lock_or_poisoned(&state.child);
    if let Some(c) = child_slot.as_mut() {
        // A transcription is in flight only if the child hasn't exited yet.
        match c.try_wait() {
            Ok(Some(_)) => {
                *child_slot = None; // stale — reap and fall through to start.
            }
            Ok(None) => {
                warn!("transcribe_audio: a transcription is already running");
                return Err("a transcription is already running".into());
            }
            Err(_) => {
                *child_slot = None;
            }
        }
    }

    let exe_suffix = if cfg!(windows) { ".exe" } else { "" };
    let bin_dir = resolve_bin_dir(&PathBuf::from(&build_dir));
    let cli = bin_dir.join(format!("llama-mtmd-cli{}", exe_suffix));
    if !cli.is_file() {
        error!(
            "transcribe_audio: llama-mtmd-cli not found at {}",
            cli.display()
        );
        return Err(format!(
            "llama-mtmd-cli not found at {} — rebuild llama.cpp with the mtmd tools",
            cli.to_string_lossy()
        ));
    }

    // Validate the model and audio paths up front so the user gets a precise
    // error instead of a wall of CLI log output.
    if let Some(model) = arg_value(&args, &["-m", "--model"]) {
        if !PathBuf::from(model).is_file() {
            return Err(format!("model file does not exist: {model}"));
        }
    } else {
        return Err("no --model given".into());
    }
    if let Some(mmproj) = arg_value(&args, &["-mm", "--mmproj"]) {
        if !PathBuf::from(mmproj).is_file() {
            return Err(format!(
                "mmproj (audio projector) file does not exist: {mmproj}"
            ));
        }
    } else {
        return Err("no --mmproj (audio projector) given".into());
    }
    if let Some(audio) = arg_value(&args, &["--audio", "--image"]) {
        if !PathBuf::from(audio).is_file() {
            return Err(format!("audio file does not exist: {audio}"));
        }
    } else {
        return Err("no --audio file given".into());
    }

    let gen = state.run_gen.fetch_add(1, Ordering::SeqCst) + 1;

    // stdin = null: with a prompt + media the CLI runs single-shot, but closing
    // stdin guarantees it can never fall into interactive chat mode and hang
    // waiting on input we'll never send.
    let mut child = quiet_command(&cli)
        .args(&args)
        .current_dir(&bin_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            error!("transcribe_audio: spawn failed: {e}");
            format!("spawn: {e}")
        })?;

    let pid = child.id();
    let started_at = chrono_now_millis();
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    *child_slot = Some(child);
    drop(child_slot);

    info!("transcribe_audio: spawned pid {pid} (gen {gen})");

    // stdout → transcription text. Read in raw chunks (not lines) so tokens
    // surface live even when the model emits a single newline-free paragraph.
    if let Some(out) = stdout_pipe {
        let app = app.clone();
        std::thread::spawn(move || {
            let mut reader = out;
            let mut buf = [0u8; 4096];
            let mut pending: Vec<u8> = Vec::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        pending.extend_from_slice(&buf[..n]);
                        let (text, rest) = split_valid_utf8(&pending);
                        pending = rest;
                        if !text.is_empty() {
                            let _ = app.emit(
                                "mtmd-event",
                                MtmdEvent {
                                    gen,
                                    kind: "output",
                                    text,
                                    code: None,
                                },
                            );
                        }
                    }
                    Err(_) => break,
                }
            }
            if !pending.is_empty() {
                let _ = app.emit(
                    "mtmd-event",
                    MtmdEvent {
                        gen,
                        kind: "output",
                        text: String::from_utf8_lossy(&pending).into_owned(),
                        code: None,
                    },
                );
            }
            debug!("transcribe stdout pump (gen {gen}) exited");
        });
    }

    // stderr → progress / errors, line-buffered.
    if let Some(err) = stderr_pipe {
        let app = app.clone();
        std::thread::spawn(move || {
            let buf = BufReader::new(err);
            for line in buf.lines() {
                match line {
                    Ok(l) => {
                        let _ = app.emit(
                            "mtmd-event",
                            MtmdEvent {
                                gen,
                                kind: "log",
                                text: l,
                                code: None,
                            },
                        );
                    }
                    Err(_) => break,
                }
            }
            debug!("transcribe stderr pump (gen {gen}) exited");
        });
    }

    // Monitor thread: reap the child and emit the terminal `done` event. Bails
    // without emitting if the generation changed (i.e. cancel_transcribe ran),
    // since the UI resets itself on cancel.
    {
        let app = app.clone();
        let child_mutex = state.child.clone();
        let run_gen = state.run_gen.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(200));
            if run_gen.load(Ordering::SeqCst) != gen {
                debug!("transcribe monitor (gen {gen}): superseded, exiting");
                return;
            }
            let mut slot = lock_or_poisoned(&child_mutex);
            let Some(c) = slot.as_mut() else { return };
            match c.try_wait() {
                Ok(Some(status)) => {
                    *slot = None;
                    drop(slot);
                    let code = status.code();
                    info!("transcribe pid {pid} (gen {gen}) exited: {code:?}");
                    let _ = app.emit(
                        "mtmd-event",
                        MtmdEvent {
                            gen,
                            kind: "done",
                            text: String::new(),
                            code,
                        },
                    );
                    return;
                }
                Ok(None) => continue,
                Err(e) => {
                    *slot = None;
                    drop(slot);
                    warn!("transcribe monitor (gen {gen}): wait error: {e}");
                    let _ = app.emit(
                        "mtmd-event",
                        MtmdEvent {
                            gen,
                            kind: "done",
                            text: String::new(),
                            code: None,
                        },
                    );
                    return;
                }
            }
        });
    }

    Ok(TranscribeStarted {
        pid,
        gen,
        started_at,
    })
}

#[tauri::command]
pub fn cancel_transcribe(state: State<'_, TranscribeState>) -> Result<(), String> {
    // Bump first so the monitor thread sees a generation change and stays
    // quiet — we own the kill + reap here.
    state.run_gen.fetch_add(1, Ordering::SeqCst);
    let mut slot = lock_or_poisoned(&state.child);
    if let Some(mut child) = slot.take() {
        info!("cancel_transcribe: killing pid {}", child.id());
        let _ = child.kill();
        let _ = child.wait();
    } else {
        debug!("cancel_transcribe: nothing running");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arg_value_reads_following_token() {
        let args: Vec<String> = ["-m", "model.gguf", "--audio", "a.wav"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(arg_value(&args, &["-m", "--model"]), Some("model.gguf"));
        assert_eq!(arg_value(&args, &["--audio", "--image"]), Some("a.wav"));
    }

    #[test]
    fn arg_value_missing_and_dangling() {
        let args: Vec<String> = ["--audio"].iter().map(|s| s.to_string()).collect();
        assert_eq!(arg_value(&args, &["-m", "--model"]), None);
        // Flag present but no value following it.
        assert_eq!(arg_value(&args, &["--audio"]), None);
    }

    #[test]
    fn split_valid_utf8_passes_clean_ascii() {
        let (text, rest) = split_valid_utf8(b"hello world");
        assert_eq!(text, "hello world");
        assert!(rest.is_empty());
    }

    #[test]
    fn split_valid_utf8_keeps_incomplete_tail() {
        // "é" is 0xC3 0xA9; feed only the lead byte.
        let bytes = [b'h', b'i', 0xC3];
        let (text, rest) = split_valid_utf8(&bytes);
        assert_eq!(text, "hi");
        assert_eq!(rest, vec![0xC3]);
        // Completing the sequence in a later read yields the full char.
        let mut next = rest;
        next.push(0xA9);
        let (text2, rest2) = split_valid_utf8(&next);
        assert_eq!(text2, "é");
        assert!(rest2.is_empty());
    }

    #[test]
    fn split_valid_utf8_replaces_invalid_bytes() {
        // 0xFF is never valid UTF-8.
        let bytes = [b'a', 0xFF, b'b'];
        let (text, rest) = split_valid_utf8(&bytes);
        assert_eq!(text, "a\u{FFFD}");
        assert_eq!(rest, vec![b'b']);
    }

    #[test]
    fn state_default_is_idle() {
        let s = TranscribeState::default();
        assert!(s.child.lock().unwrap().is_none());
        assert_eq!(s.run_gen.load(Ordering::SeqCst), 0);
    }
}
