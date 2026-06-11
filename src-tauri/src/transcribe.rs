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

/// Base64 payload for a single image, ready to drop into an `image_url` content
/// part as `data:<mime>;base64,<data>`. `format` is the canonical extension
/// (`jpeg`, `png`, `gif`, `webp`); `mime` is `image/<format>` so the frontend
/// doesn't have to re-derive it.
#[derive(Debug, Clone, Serialize)]
pub struct ImagePayload {
    pub data: String,
    pub format: String,
    pub mime: String,
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

/// Map a file extension to a canonical image format for an `image_url` data
/// URL. Accepts the formats llama.cpp's vision projectors decode; `jpg`
/// normalises to `jpeg` so the emitted MIME type is `image/jpeg`.
fn image_format_from_path(path: &Path) -> Result<String, String> {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .as_deref()
    {
        Some("jpg") | Some("jpeg") => Ok("jpeg".to_string()),
        Some("png") => Ok("png".to_string()),
        Some("gif") => Ok("gif".to_string()),
        Some("webp") => Ok("webp".to_string()),
        other => Err(format!(
            "image attachments support jpg/jpeg/png/gif/webp only (got {})",
            other.unwrap_or("a file with no extension")
        )),
    }
}

/// Sanitize a frontend-supplied filename: strip any directory components and
/// reject empties/`.`/`..` so a hostile name can't escape the recordings dir.
fn sanitize_filename(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    let f = Path::new(trimmed)
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| format!("invalid filename: {name}"))?;
    if f.is_empty() || f == "." || f == ".." {
        return Err(format!("invalid filename: {name}"));
    }
    Ok(f.to_string())
}

/// Persist a WAV clip captured by the in-app recorder into `dir` under `name`,
/// returning the file path. The Transcribe screen reuses a single
/// `recording.wav` (the UI disables recording while transcription runs); the
/// Chat screen passes a unique name per clip so older attachments still play
/// back when the chat is reopened. The payload is validated as RIFF/WAVE so a
/// malformed body fails loudly here instead of as opaque server output.
fn write_recording(dir: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("recording is not a WAV stream".into());
    }
    let filename = sanitize_filename(name)?;
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let path = dir.join(filename);
    std::fs::write(&path, bytes).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(path)
}

/// Write a freshly recorded clip to the app cache dir and hand its path back to
/// the frontend, which then feeds it to `read_audio_base64` like a picked file.
/// `name` defaults to `recording.wav` (used by Transcribe); the Chat composer
/// passes a unique name per clip so attachments don't clobber each other.
#[tauri::command]
pub fn save_recording(
    app: AppHandle,
    bytes: Vec<u8>,
    name: Option<String>,
) -> Result<String, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("no app cache dir: {e}"))?
        .join("recordings");
    let filename = name.as_deref().unwrap_or("recording.wav");
    let path = write_recording(&dir, filename, &bytes)?;
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

/// Read an image file and base64-encode it for an `image_url` request body.
/// Used by the chat composer when a vision model is loaded — the file is read
/// straight off the user-picked path (no save step, unlike recordings).
#[tauri::command]
pub fn read_image_base64(path: String) -> Result<ImagePayload, String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("image file does not exist: {path}"));
    }
    let format = image_format_from_path(&p)?;
    let bytes = std::fs::read(&p).map_err(|e| format!("read {path}: {e}"))?;
    info!(
        "read_image_base64: {} ({} bytes, {format})",
        p.display(),
        bytes.len()
    );
    let mime = format!("image/{format}");
    Ok(ImagePayload {
        data: to_base64(&bytes),
        format,
        mime,
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

    #[test]
    fn image_format_normalises_jpg_and_accepts_known_types() {
        assert_eq!(image_format_from_path(Path::new("a.jpg")).unwrap(), "jpeg");
        assert_eq!(image_format_from_path(Path::new("a.JPEG")).unwrap(), "jpeg");
        assert_eq!(image_format_from_path(Path::new("a.png")).unwrap(), "png");
        assert_eq!(image_format_from_path(Path::new("a.GIF")).unwrap(), "gif");
        assert_eq!(image_format_from_path(Path::new("a.webp")).unwrap(), "webp");
    }

    #[test]
    fn image_format_rejects_other_extensions() {
        assert!(image_format_from_path(Path::new("a.bmp")).is_err());
        assert!(image_format_from_path(Path::new("a.tiff")).is_err());
        assert!(image_format_from_path(Path::new("a.svg")).is_err());
        assert!(image_format_from_path(Path::new("noext")).is_err());
    }

    #[test]
    fn read_image_base64_round_trips_a_tiny_png() {
        // 1×1 transparent PNG, base64-decoded into raw bytes for the fixture.
        const PNG_B64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
        let bytes = decode_b64_for_test(PNG_B64);
        let dir = std::env::temp_dir().join(format!("llammaui-img-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("pixel.png");
        std::fs::write(&path, &bytes).unwrap();

        let payload = read_image_base64(path.to_string_lossy().into_owned()).unwrap();
        assert_eq!(payload.format, "png");
        assert_eq!(payload.mime, "image/png");
        // Re-encoding the bytes we wrote must reproduce the original base64.
        assert_eq!(payload.data, to_base64(&bytes));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_image_base64_rejects_missing_and_unsupported() {
        assert!(read_image_base64("Z:/does/not/exist.png".into()).is_err());
    }

    /// Minimal RFC 4648 base64 decoder — test-only, just to build the PNG
    /// fixture above without pulling in a dependency.
    fn decode_b64_for_test(s: &str) -> Vec<u8> {
        let mut lut = [255u8; 256];
        for (i, b) in B64_ALPHABET.iter().enumerate() {
            lut[*b as usize] = i as u8;
        }
        let mut out = Vec::new();
        let mut buf = 0u32;
        let mut bits = 0u32;
        for &c in s.as_bytes() {
            if c == b'=' {
                break;
            }
            let v = lut[c as usize];
            assert_ne!(v, 255, "bad base64 char in fixture");
            buf = (buf << 6) | v as u32;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                out.push((buf >> bits) as u8);
            }
        }
        out
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
    fn write_recording_persists_a_wav_under_requested_name() {
        let dir = std::env::temp_dir().join(format!("llammaui-rec-ok-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path =
            write_recording(&dir, "recording.wav", &tiny_wav()).expect("valid wav should write");
        assert!(path.is_file());
        assert_eq!(
            path.file_name().and_then(|n| n.to_str()),
            Some("recording.wav")
        );
        assert_eq!(&std::fs::read(&path).unwrap()[0..4], b"RIFF");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_recording_uses_custom_filename_for_chat_clips() {
        let dir = std::env::temp_dir().join(format!("llammaui-rec-named-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path =
            write_recording(&dir, "chat-123-abc.wav", &tiny_wav()).expect("valid wav should write");
        assert_eq!(
            path.file_name().and_then(|n| n.to_str()),
            Some("chat-123-abc.wav")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_recording_rejects_non_wav_payloads() {
        let dir = std::env::temp_dir().join(format!("llammaui-rec-bad-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // Right length, wrong magic.
        assert!(write_recording(&dir, "recording.wav", b"NOPExxxxNOPE").is_err());
        // Too short to even carry the RIFF/WAVE tags.
        assert!(write_recording(&dir, "recording.wav", b"RIFF").is_err());
        // Rejected before the directory is created.
        assert!(!dir.exists());
    }

    #[test]
    fn write_recording_strips_path_components_from_supplied_names() {
        let dir = std::env::temp_dir().join(format!("llammaui-rec-trav-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // Both "../" and nested "sub/dir/" must collapse to their basename so
        // the write always lands inside `dir`.
        let p1 = write_recording(&dir, "../escape.wav", &tiny_wav()).expect("basename allowed");
        let p2 =
            write_recording(&dir, "sub/dir/escape.wav", &tiny_wav()).expect("basename allowed");
        assert_eq!(p1.parent(), Some(dir.as_path()));
        assert_eq!(p2.parent(), Some(dir.as_path()));
        assert_eq!(p1.file_name().and_then(|n| n.to_str()), Some("escape.wav"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_recording_rejects_unusable_names() {
        let dir =
            std::env::temp_dir().join(format!("llammaui-rec-bad-name-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(write_recording(&dir, "", &tiny_wav()).is_err());
        assert!(write_recording(&dir, ".", &tiny_wav()).is_err());
        assert!(write_recording(&dir, "..", &tiny_wav()).is_err());
        assert!(!dir.exists());
    }
}
