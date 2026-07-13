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
    /// Distinct ggml tensor quant types present in the file (e.g. `["Q4_K",
    /// "F32"]`), in first-seen order. Lets the UI (and `hipfire_convert`) flag
    /// quant formats an engine can't load/convert BEFORE launch/conversion.
    /// Unknown ids become `"TYPE_<id>"`. Empty when the tensor table couldn't
    /// be read — treat as "unknown", not "no tensors".
    pub tensor_types: Vec<String>,
}

/// Map a ggml tensor type id to its canonical name. Unknown ids become
/// `TYPE_<id>` so the UI can still surface (and flag) them. Pure + testable.
/// Ids mirror ggml's `enum ggml_type`.
fn ggml_type_name(id: u32) -> String {
    match id {
        0 => "F32",
        1 => "F16",
        2 => "Q4_0",
        3 => "Q4_1",
        6 => "Q5_0",
        7 => "Q5_1",
        8 => "Q8_0",
        9 => "Q8_1",
        10 => "Q2_K",
        11 => "Q3_K",
        12 => "Q4_K",
        13 => "Q5_K",
        14 => "Q6_K",
        15 => "Q8_K",
        16 => "IQ2_XXS",
        17 => "IQ2_XS",
        18 => "IQ3_XXS",
        19 => "IQ1_S",
        20 => "IQ4_NL",
        21 => "IQ3_S",
        22 => "IQ2_S",
        23 => "IQ4_XS",
        29 => "IQ1_M",
        30 => "BF16",
        39 => "MXFP4",
        other => return format!("TYPE_{other}"),
    }
    .to_string()
}

/// Read the tensor-descriptor section — which begins immediately after the
/// metadata KV block — and return the DISTINCT ggml type names in first-seen
/// order. Best-effort by design: a short/corrupt read returns whatever was
/// collected so far rather than erroring, so `inspect_gguf` never regresses for
/// odd files. Each descriptor is: name (gguf string), `n_dims: u32`,
/// `dims: u64 × n_dims`, `ggml_type: u32`, `offset: u64`.
fn read_tensor_types<R: Read>(r: &mut R, tensor_count: u64) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for _ in 0..tensor_count {
        // name (gguf string) — u64 length prefix + bytes.
        if gguf_read_string(r).is_err() {
            break;
        }
        let n_dims = match gguf_read_u32(r) {
            Ok(n) => n,
            Err(_) => break,
        };
        // ggml tops out at 4 dims; a wild count means we've lost sync — stop.
        if n_dims > 8 {
            break;
        }
        let mut sync_lost = false;
        for _ in 0..n_dims {
            if gguf_read_u64(r).is_err() {
                sync_lost = true;
                break;
            }
        }
        if sync_lost {
            break;
        }
        let ty = match gguf_read_u32(r) {
            Ok(t) => t,
            Err(_) => break,
        };
        // offset (u64) — consume so the next descriptor lines up.
        if gguf_read_u64(r).is_err() {
            break;
        }
        let name = ggml_type_name(ty);
        if !seen.contains(&name) {
            seen.push(name);
        }
    }
    seen
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
                block_count = gguf_read_u64_value(&mut r, ty)
                    .map_err(|e| format!("read block_count: {e}"))?;
            }
            _ => {
                gguf_skip_value(&mut r, ty).map_err(|e| format!("skip kv {key}: {e}"))?;
            }
        }
    }

    // The KV loop above fully consumes every value (each arm reads or skips the
    // whole value, and it never breaks early), so the reader is now positioned
    // exactly at the first tensor descriptor. Enumerate the distinct quant types
    // best-effort — a parse hiccup yields a partial/empty vec, never an error.
    let tensor_types = read_tensor_types(&mut r, tensor_count);

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
        tensor_types,
    };
    log::info!(
        "inspect_gguf: arch={:?} mtp={} ctx={:?} layers={:?} size={:.2} GB mmproj={} thinking={}({:?}) quants={:?}",
        info.architecture,
        info.mtp_support,
        info.context_length,
        info.block_count,
        info.size_gb,
        info.mmproj_siblings.len(),
        info.supports_thinking,
        info.thinking_style,
        info.tensor_types,
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

    #[test]
    fn ggml_type_name_maps_known_ids() {
        assert_eq!(ggml_type_name(0), "F32");
        assert_eq!(ggml_type_name(1), "F16");
        assert_eq!(ggml_type_name(2), "Q4_0");
        assert_eq!(ggml_type_name(8), "Q8_0");
        assert_eq!(ggml_type_name(12), "Q4_K");
        assert_eq!(ggml_type_name(13), "Q5_K");
        assert_eq!(ggml_type_name(14), "Q6_K");
        assert_eq!(ggml_type_name(23), "IQ4_XS");
        assert_eq!(ggml_type_name(30), "BF16");
        assert_eq!(ggml_type_name(39), "MXFP4");
    }

    #[test]
    fn ggml_type_name_falls_back_for_unknown_ids() {
        assert_eq!(ggml_type_name(101), "TYPE_101");
        assert_eq!(ggml_type_name(255), "TYPE_255");
    }

    // Append one tensor descriptor (name, n_dims, dims, ggml_type, offset) to a
    // byte buffer in GGUF layout, so tests can synthesise a descriptor section.
    fn push_descriptor(buf: &mut Vec<u8>, name: &str, dims: &[u64], ty: u32, offset: u64) {
        buf.extend_from_slice(&(name.len() as u64).to_le_bytes());
        buf.extend_from_slice(name.as_bytes());
        buf.extend_from_slice(&(dims.len() as u32).to_le_bytes());
        for d in dims {
            buf.extend_from_slice(&d.to_le_bytes());
        }
        buf.extend_from_slice(&ty.to_le_bytes());
        buf.extend_from_slice(&offset.to_le_bytes());
    }

    #[test]
    fn read_tensor_types_collects_distinct_in_first_seen_order() {
        let mut buf = Vec::new();
        push_descriptor(&mut buf, "a", &[10], 12, 0); // Q4_K
        push_descriptor(&mut buf, "b", &[10, 20], 0, 100); // F32
        push_descriptor(&mut buf, "c", &[5], 12, 200); // Q4_K again (dedup)
        push_descriptor(&mut buf, "d", &[7], 101, 300); // unknown -> TYPE_101
        let mut c = Cursor::new(buf);
        let types = read_tensor_types(&mut c, 4);
        assert_eq!(types, vec!["Q4_K", "F32", "TYPE_101"]);
    }

    #[test]
    fn read_tensor_types_returns_partial_on_truncation() {
        // One full descriptor, then a truncated second one (EOF mid-descriptor).
        let mut buf = Vec::new();
        push_descriptor(&mut buf, "a", &[10], 8, 0); // Q8_0
        buf.extend_from_slice(&(1u64).to_le_bytes()); // start of a name len...
        buf.extend_from_slice(b"b"); // ...name, then EOF before n_dims
        let mut c = Cursor::new(buf);
        // Claim 3 tensors but the stream ends after ~1.x — must not panic/error.
        let types = read_tensor_types(&mut c, 3);
        assert_eq!(types, vec!["Q8_0"]);
    }

    #[test]
    fn read_tensor_types_empty_for_zero_count() {
        let mut c = Cursor::new(Vec::new());
        assert!(read_tensor_types(&mut c, 0).is_empty());
    }
}
