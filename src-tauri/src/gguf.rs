use std::fs;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::PathBuf;

use log::warn;
use serde::Serialize;

use crate::models_scan::is_mmproj_filename;

// GGUF v2/v3 layout:
//   magic    : "GGUF"
//   version  : u32_le
//   tensor_count    : u64_le
//   metadata_count  : u64_le
//   metadata_kvs    : repeat (string key, u32 type, value)
//   tensor_infos    : repeat (string name, u32 n_dims, u64[n_dims] dims, u32 type, u64 offset)

#[derive(Debug, Serialize)]
pub struct GgufInfo {
    pub path: String,
    pub gguf_version: u32,
    pub tensor_count: u64,
    pub metadata_count: u64,
    pub architecture: Option<String>,
    pub general_name: Option<String>,
    pub context_length: Option<u64>,
    /// Transformer block/layer count (`{arch}.block_count`). Lets the UI scale
    /// the GPU-offload (ngl) slider to the model's real layer count instead of
    /// a fixed 0-100 range.
    pub block_count: Option<u64>,
    pub mtp_support: bool,
    pub size_gb: f64,
    /// Sibling mmproj-*.gguf files in the same directory as this model.
    /// Lets the UI auto-set `--mmproj` for vision-capable bundles.
    pub mmproj_siblings: Vec<String>,
    /// True when the embedded chat template references `enable_thinking` —
    /// i.e. it's meaningful to pass `chat_template_kwargs:{enable_thinking}`.
    /// Lets the UI gate the reasoning toggle per model instead of guessing.
    pub supports_thinking: bool,
    /// Coarse classification of HOW the template renders reasoning:
    /// `"channel"` (gemma-style `<|channel>thought`/`<|think|>`),
    /// `"think_tags"` (`<think>…</think>`), `"other"` (toggle present but
    /// unrecognised markup), or `None` (no thinking mechanism detected).
    pub thinking_style: Option<String>,
}

/// Classify a chat template's thinking mechanism. Pure + string-based so it's
/// cheap and unit-testable. See `GgufInfo::supports_thinking`/`thinking_style`.
fn classify_thinking(template: &str) -> (bool, Option<String>) {
    let supports = template.contains("enable_thinking");
    let style = if template.contains("<|channel") || template.contains("<|think|>") {
        Some("channel".to_string())
    } else if template.contains("<think>") {
        Some("think_tags".to_string())
    } else if supports {
        Some("other".to_string())
    } else {
        None
    };
    (supports, style)
}

pub fn gguf_read_u32<R: Read>(r: &mut R) -> io::Result<u32> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b)?;
    Ok(u32::from_le_bytes(b))
}

pub fn gguf_read_u64<R: Read>(r: &mut R) -> io::Result<u64> {
    let mut b = [0u8; 8];
    r.read_exact(&mut b)?;
    Ok(u64::from_le_bytes(b))
}

pub fn gguf_read_string<R: Read>(r: &mut R) -> io::Result<String> {
    let len = gguf_read_u64(r)? as usize;
    if len > 16 * 1024 * 1024 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("GGUF string too long ({len})"),
        ));
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

pub fn gguf_skip_value<R: Read + Seek>(r: &mut R, ty: u32) -> io::Result<()> {
    match ty {
        0 | 1 | 7 => {
            r.seek(SeekFrom::Current(1))?;
        } // u8 / i8 / bool
        2 | 3 => {
            r.seek(SeekFrom::Current(2))?;
        } // u16 / i16
        4..=6 => {
            r.seek(SeekFrom::Current(4))?;
        } // u32 / i32 / f32
        10..=12 => {
            r.seek(SeekFrom::Current(8))?;
        } // u64 / i64 / f64
        8 => {
            // string
            let _ = gguf_read_string(r)?;
        }
        9 => {
            // array
            let inner = gguf_read_u32(r)?;
            let count = gguf_read_u64(r)?;
            for _ in 0..count {
                gguf_skip_value(r, inner)?;
            }
        }
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("unknown GGUF value type {ty}"),
            ));
        }
    }
    Ok(())
}

pub fn gguf_read_u64_value<R: Read + Seek>(r: &mut R, ty: u32) -> io::Result<Option<u64>> {
    Ok(match ty {
        4 => Some(gguf_read_u32(r)? as u64),
        5 => Some(gguf_read_u32(r)? as i32 as i64 as u64),
        10 => Some(gguf_read_u64(r)?),
        11 => Some(gguf_read_u64(r)?),
        _ => {
            gguf_skip_value(r, ty)?;
            None
        }
    })
}

#[tauri::command]
pub fn inspect_gguf(path: String) -> Result<GgufInfo, String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("not a file: {path}"));
    }
    let meta = fs::metadata(&p).map_err(|e| format!("stat: {e}"))?;
    let size_gb = meta.len() as f64 / 1024.0 / 1024.0 / 1024.0;

    let f = fs::File::open(&p).map_err(|e| format!("open: {e}"))?;
    let mut r = std::io::BufReader::new(f);

    let mut magic = [0u8; 4];
    r.read_exact(&mut magic)
        .map_err(|e| format!("read magic: {e}"))?;
    if &magic != b"GGUF" {
        return Err(format!(
            "not a GGUF file (magic = {:?})",
            String::from_utf8_lossy(&magic)
        ));
    }

    let version = gguf_read_u32(&mut r).map_err(|e| format!("read version: {e}"))?;
    if version < 2 {
        return Err(format!("GGUF v{version} too old (need >= 2)"));
    }
    let tensor_count = gguf_read_u64(&mut r).map_err(|e| format!("read tcount: {e}"))?;
    let metadata_count = gguf_read_u64(&mut r).map_err(|e| format!("read mcount: {e}"))?;

    let mut architecture: Option<String> = None;
    let mut general_name: Option<String> = None;
    let mut context_length: Option<u64> = None;
    let mut block_count: Option<u64> = None;
    let mut chat_template: Option<String> = None;

    for i in 0..metadata_count {
        let key = gguf_read_string(&mut r).map_err(|e| format!("read kv key at {i}: {e}"))?;
        let ty = gguf_read_u32(&mut r).map_err(|e| format!("read kv type at {i}: {e}"))?;
        match key.as_str() {
            "general.architecture" if ty == 8 => {
                architecture =
                    Some(gguf_read_string(&mut r).map_err(|e| format!("read architecture: {e}"))?);
            }
            "general.name" if ty == 8 => {
                general_name =
                    Some(gguf_read_string(&mut r).map_err(|e| format!("read general.name: {e}"))?);
            }
            // Capture only the DEFAULT template (exact key). Named variants like
            // `tokenizer.chat_template.tool_use` fall through to skip.
            "tokenizer.chat_template" if ty == 8 => {
                chat_template =
                    Some(gguf_read_string(&mut r).map_err(|e| format!("read chat_template: {e}"))?);
            }
            k if k.ends_with(".context_length") => {
                context_length = gguf_read_u64_value(&mut r, ty)
                    .map_err(|e| format!("read context_length: {e}"))?;
            }
            // `{arch}.block_count` = transformer layer count. `ends_with` mirrors
            // the context_length match; the leading `.` guard means keys like
            // `deepseek2.leading_dense_block_count` don't clobber it.
            k if k.ends_with(".block_count") => {
                block_count =
                    gguf_read_u64_value(&mut r, ty).map_err(|e| format!("read block_count: {e}"))?;
            }
            _ => {
                gguf_skip_value(&mut r, ty).map_err(|e| format!("skip kv {key}: {e}"))?;
            }
        }
    }

    let (supports_thinking, thinking_style) = match chat_template.as_deref() {
        Some(t) => classify_thinking(t),
        None => (false, None),
    };

    // MTP support is signalled by an "-MTP" token in the filename (case-
    // insensitive). Cheaper and just as reliable as scanning the tensor table,
    // since this is how upstream model authors actually mark MTP-capable GGUFs.
    let mtp_support = p
        .file_name()
        .and_then(|s| s.to_str())
        .map(|n| n.to_lowercase().contains("-mtp"))
        .unwrap_or(false);

    let mut mmproj_siblings: Vec<String> = Vec::new();
    if let Some(dir) = p.parent() {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry_res in entries {
                let entry = match entry_res {
                    Ok(e) => e,
                    Err(e) => {
                        warn!("inspect_gguf: skipping sibling: {e}");
                        continue;
                    }
                };
                let sp = entry.path();
                if !sp.is_file() {
                    continue;
                }
                let name = sp.file_name().and_then(|s| s.to_str()).unwrap_or("");
                if name.to_lowercase().ends_with(".gguf") && is_mmproj_filename(name) {
                    mmproj_siblings.push(sp.to_string_lossy().into_owned());
                }
            }
            mmproj_siblings.sort();
        }
    }

    let info = GgufInfo {
        path,
        gguf_version: version,
        tensor_count,
        metadata_count,
        architecture,
        general_name,
        context_length,
        block_count,
        mtp_support,
        size_gb,
        mmproj_siblings,
        supports_thinking,
        thinking_style,
    };
    log::info!(
        "inspect_gguf: arch={:?} mtp={} ctx={:?} layers={:?} size={:.2} GB mmproj={} thinking={}({:?})",
        info.architecture,
        info.mtp_support,
        info.context_length,
        info.block_count,
        info.size_gb,
        info.mmproj_siblings.len(),
        info.supports_thinking,
        info.thinking_style,
    );
    Ok(info)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn gguf_read_u32_reads_little_endian() {
        let mut c = Cursor::new(vec![0x78, 0x56, 0x34, 0x12]);
        assert_eq!(gguf_read_u32(&mut c).unwrap(), 0x12345678);
    }

    #[test]
    fn gguf_read_u64_reads_little_endian() {
        let bytes: Vec<u8> = (1u8..=8).collect();
        let mut c = Cursor::new(bytes);
        let v = gguf_read_u64(&mut c).unwrap();
        // 0x0807060504030201
        assert_eq!(v, 0x0807060504030201);
    }

    #[test]
    fn gguf_read_string_roundtrips_utf8() {
        let mut payload: Vec<u8> = (5u64).to_le_bytes().to_vec();
        payload.extend_from_slice(b"hello");
        let mut c = Cursor::new(payload);
        assert_eq!(gguf_read_string(&mut c).unwrap(), "hello");
    }

    #[test]
    fn gguf_read_string_rejects_oversize_prefix() {
        let payload: Vec<u8> = (32u64 * 1024 * 1024).to_le_bytes().to_vec();
        let mut c = Cursor::new(payload);
        let err = gguf_read_string(&mut c).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn gguf_skip_value_handles_fixed_size_types() {
        // type 4 (u32) — skip 4 bytes; the next read should land on byte 5.
        let mut data = vec![0u8; 8];
        data[4] = 0xAB;
        let mut c = Cursor::new(data);
        gguf_skip_value(&mut c, 4).unwrap();
        let mut next = [0u8; 1];
        c.read_exact(&mut next).unwrap();
        assert_eq!(next[0], 0xAB);
    }

    #[test]
    fn gguf_skip_value_rejects_unknown_type() {
        let mut c = Cursor::new(vec![0u8; 4]);
        let err = gguf_skip_value(&mut c, 99).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn gguf_read_u64_value_reads_explicit_widths() {
        let mut buf = vec![];
        buf.extend_from_slice(&(7u32).to_le_bytes());
        let mut c = Cursor::new(buf);
        assert_eq!(gguf_read_u64_value(&mut c, 4).unwrap(), Some(7));

        let mut buf2 = vec![];
        buf2.extend_from_slice(&(13u64).to_le_bytes());
        let mut c2 = Cursor::new(buf2);
        assert_eq!(gguf_read_u64_value(&mut c2, 10).unwrap(), Some(13));
    }

    #[test]
    fn gguf_read_u64_value_returns_none_for_unrecognised_type() {
        // type 7 (bool) — skip 1 byte, return None.
        let mut c = Cursor::new(vec![0u8]);
        let out = gguf_read_u64_value(&mut c, 7).unwrap();
        assert!(out.is_none());
    }

    #[test]
    fn inspect_gguf_rejects_missing_file() {
        let err = inspect_gguf("Z:/no-such-file.gguf".into()).unwrap_err();
        assert!(err.contains("not a file"));
    }

    #[test]
    fn classify_thinking_detects_gemma_channel_format() {
        // Real gemma-4 snippet: enable_thinking guard + <|channel>thought markup.
        let t = "{%- if enable_thinking is defined and enable_thinking -%}{{- '<|think|>\\n' -}}\
                 {%- if not enable_thinking | default(false) -%}{{- '<|channel>thought\\n<channel|>' -}}";
        let (supports, style) = classify_thinking(t);
        assert!(supports);
        assert_eq!(style.as_deref(), Some("channel"));
    }

    #[test]
    fn classify_thinking_detects_qwen_think_tags() {
        // Real Qwen3.6 snippet: enable_thinking guard + <think>…</think>.
        let t = "{%- if enable_thinking is defined and enable_thinking is false %}\
                 {{- '<think>\\n\\n</think>\\n\\n' }}{%- else %}{{- '<think>\\n' }}";
        let (supports, style) = classify_thinking(t);
        assert!(supports);
        assert_eq!(style.as_deref(), Some("think_tags"));
    }

    #[test]
    fn classify_thinking_handles_no_thinking_template() {
        // A plain template (no enable_thinking, no think markup).
        let t = "{% for m in messages %}{{ m.role }}: {{ m.content }}\n{% endfor %}";
        let (supports, style) = classify_thinking(t);
        assert!(!supports);
        assert_eq!(style, None);
    }

    #[test]
    fn classify_thinking_marks_toggle_without_known_markup_as_other() {
        let t = "{%- if enable_thinking %}reason now{%- endif %}";
        let (supports, style) = classify_thinking(t);
        assert!(supports);
        assert_eq!(style.as_deref(), Some("other"));
    }
}
