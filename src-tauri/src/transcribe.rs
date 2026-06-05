//! Audio file helpers for server-based transcription.
//!
//! Transcription itself runs through the already-running `llama-server`: the
//! frontend POSTs an `input_audio` content part to `/v1/chat/completions` and
//! streams the reply (mirroring the chat flow). The CLI no longer spawns a
//! `llama-mtmd-cli` per clip. These two commands are the only native pieces the
//! audio path needs:
//!
//! * [`save_recording`] persists an in-app mic recording (a complete WAV byte
//!   stream) to the app cache dir and returns its path.
//! * [`read_audio_base64`] reads a wav/mp3 file off disk and base64-encodes it
//!   for the request body. Recordings and picked files both arrive here as a
//!   path, so this is the single audio→base64 entry point.

use std::path::{Path, PathBuf};

use log::info;
use serde::Serialize;
use tauri::{AppHandle, Manager};

/// Base64 payload for a single audio clip, ready to drop into an `input_audio`
/// content part. `format` is `"wav"` or `"mp3"` (what llama-server accepts).
#[derive(Debug, Clone, Serialize)]
pub struct AudioPayload {
    pub data: String,
    pub format: String,
}

/// Standard RFC 4648 base64 alphabet (with `+` `/` and `=` padding).
const B64_ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Encode bytes as base64. Hand-rolled to keep the dependency tree flat (mirrors
/// the existing hand-rolled UTF-8 handling this module used to carry).
fn to_base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64_ALPHABET[((n >> 18) & 0x3f) as usize] as char);
        out.push(B64_ALPHABET[((n >> 12) & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 {
            B64_ALPHABET[((n >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64_ALPHABET[(n & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// Map a file extension to the `input_audio` format string. llama-server only
/// accepts wav/mp3, so anything else fails here with a clear message rather
/// than as an opaque server error.
fn audio_format_from_path(path: &Path) -> Result<String, String> {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .as_deref()
    {
        Some("wav") => Ok("wav".to_string()),
        Some("mp3") => Ok("mp3".to_string()),
        other => Err(format!(
            "server transcription supports wav/mp3 only (got {})",
            other.unwrap_or("a file with no extension")
        )),
    }
}

/// Persist a WAV clip captured by the in-app recorder into `dir`, returning the
/// file path. We reuse a single `recording.wav` (the UI disables recording while
/// a transcription runs, so there's never a live reader to clobber) and validate
/// the payload is a RIFF/WAVE stream so a malformed body fails loudly here
/// instead of as opaque server output.
fn write_recording(dir: &Path, bytes: &[u8]) -> Result<PathBuf, String> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("recording is not a WAV stream".into());
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let path = dir.join("recording.wav");
    std::fs::write(&path, bytes).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(path)
}

/// Write a freshly recorded clip to the app cache dir and hand its path back to
/// the frontend, which then feeds it to `read_audio_base64` like a picked file.
#[tauri::command]
pub fn save_recording(app: AppHandle, bytes: Vec<u8>) -> Result<String, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("no app cache dir: {e}"))?
        .join("recordings");
    let path = write_recording(&dir, &bytes)?;
    info!(
        "save_recording: wrote {} bytes to {}",
        bytes.len(),
        path.display()
    );
    Ok(path.to_string_lossy().into_owned())
}

/// Read a wav/mp3 file and base64-encode it for an `input_audio` request body.
#[tauri::command]
pub fn read_audio_base64(path: String) -> Result<AudioPayload, String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("audio file does not exist: {path}"));
    }
    let format = audio_format_from_path(&p)?;
    let bytes = std::fs::read(&p).map_err(|e| format!("read {path}: {e}"))?;
    info!(
        "read_audio_base64: {} ({} bytes, {format})",
        p.display(),
        bytes.len()
    );
    Ok(AudioPayload {
        data: to_base64(&bytes),
        format,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_base64_matches_rfc4648_vectors() {
        assert_eq!(to_base64(b""), "");
        assert_eq!(to_base64(b"f"), "Zg==");
        assert_eq!(to_base64(b"fo"), "Zm8=");
        assert_eq!(to_base64(b"foo"), "Zm9v");
        assert_eq!(to_base64(b"foob"), "Zm9vYg==");
        assert_eq!(to_base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(to_base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn to_base64_handles_high_bytes() {
        assert_eq!(to_base64(&[0xff, 0xff, 0xff]), "////");
        assert_eq!(to_base64(&[0x00, 0x00, 0x00]), "AAAA");
    }

    #[test]
    fn audio_format_accepts_wav_mp3_case_insensitively() {
        assert_eq!(audio_format_from_path(Path::new("a.wav")).unwrap(), "wav");
        assert_eq!(audio_format_from_path(Path::new("a.WAV")).unwrap(), "wav");
        assert_eq!(audio_format_from_path(Path::new("a.Mp3")).unwrap(), "mp3");
    }

    #[test]
    fn audio_format_rejects_other_extensions() {
        assert!(audio_format_from_path(Path::new("a.flac")).is_err());
        assert!(audio_format_from_path(Path::new("a.ogg")).is_err());
        assert!(audio_format_from_path(Path::new("noext")).is_err());
    }

    /// Minimal but structurally valid WAV (RIFF + size + WAVE).
    fn tiny_wav() -> Vec<u8> {
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&4u32.to_le_bytes());
        wav.extend_from_slice(b"WAVE");
        wav
    }

    #[test]
    fn write_recording_persists_a_wav_named_recording() {
        let dir = std::env::temp_dir().join(format!("llammaui-rec-ok-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = write_recording(&dir, &tiny_wav()).expect("valid wav should write");
        assert!(path.is_file());
        assert_eq!(
            path.file_name().and_then(|n| n.to_str()),
            Some("recording.wav")
        );
        assert_eq!(&std::fs::read(&path).unwrap()[0..4], b"RIFF");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_recording_rejects_non_wav_payloads() {
        let dir = std::env::temp_dir().join(format!("llammaui-rec-bad-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // Right length, wrong magic.
        assert!(write_recording(&dir, b"NOPExxxxNOPE").is_err());
        // Too short to even carry the RIFF/WAVE tags.
        assert!(write_recording(&dir, b"RIFF").is_err());
        // Rejected before the directory is created.
        assert!(!dir.exists());
    }
}
