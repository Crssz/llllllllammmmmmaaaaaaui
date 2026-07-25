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
    /// Attention geometry, read from the architecture-prefixed KV block. A KV
    /// cache costs `layers × kv_heads × head_dim × ctx × dtype_width` bytes per
    /// tensor, so the UI needs every one of these terms to size it. They stay
    /// `Option` because plenty of GGUFs omit some, and a fabricated default
    /// here becomes an understated memory estimate downstream — which is what
    /// makes long context look free right up until the model fails to load.
    pub head_count_kv: Option<u64>,
    pub head_count: Option<u64>,
    /// Per-head K/V widths (`{arch}.attention.key_length` / `.value_length`).
    /// Most architectures omit them; fall back to `embedding_length /
    /// head_count`.
    pub key_length: Option<u64>,
    pub value_length: Option<u64>,
    pub embedding_length: Option<u64>,
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

/// The numeric metadata keys we care about, WITHOUT their architecture prefix.
/// In the file they're arch-prefixed (`llama.attention.head_count`,
/// `qwen2.embedding_length`, `gemma3.block_count`), and `general.architecture`
/// isn't *guaranteed* to be declared before them, so the KV loop collects every
/// key ending in one of these suffixes and `resolve_meta` picks the arch-owned
/// one once the whole block has been read.
const NUMERIC_KEY_SUFFIXES: [&str; 7] = [
    ".context_length",
    ".block_count",
    ".embedding_length",
    ".attention.head_count",
    ".attention.head_count_kv",
    ".attention.key_length",
    ".attention.value_length",
];

/// Header fields + the metadata values `inspect_gguf` cares about. Split out of
/// the command so the parse is testable over an in-memory cursor.
#[derive(Debug)]
struct ParsedMeta {
    version: u32,
    tensor_count: u64,
    metadata_count: u64,
    architecture: Option<String>,
    general_name: Option<String>,
    chat_template: Option<String>,
    /// Every `NUMERIC_KEY_SUFFIXES` hit as (full key, value), in file order.
    numeric: Vec<(String, u64)>,
}

/// Pick the value of `{arch}{suffix}` out of the collected numeric KVs.
///
/// Falls back to a *unique* suffix match when the architecture is unknown or
/// doesn't own the key (hand-built GGUFs, mmproj bundles whose keys sit under
/// `clip.vision.`). An ambiguous suffix — two architectures' worth of the same
/// key — resolves to `None`: guessing which one describes the text model is how
/// you end up with a head count that belongs to a vision tower.
fn resolve_meta(entries: &[(String, u64)], arch: Option<&str>, suffix: &str) -> Option<u64> {
    if let Some(a) = arch {
        let want = format!("{a}{suffix}");
        if let Some((_, v)) = entries.iter().find(|(k, _)| *k == want) {
            return Some(*v);
        }
    }
    let mut hits = entries.iter().filter(|(k, _)| k.ends_with(suffix));
    match (hits.next(), hits.next()) {
        (Some((_, v)), None) => Some(*v),
        _ => None,
    }
}

/// Read the GGUF header and walk the metadata KV block, capturing the strings
/// and numbers we surface. Every arm reads or skips its value in full and the
/// loop never breaks early, so on return the reader sits exactly at the first
/// tensor descriptor.
fn read_header_and_metadata<R: Read + Seek>(r: &mut R) -> Result<ParsedMeta, String> {
    let mut magic = [0u8; 4];
    r.read_exact(&mut magic)
        .map_err(|e| format!("read magic: {e}"))?;
    if &magic != b"GGUF" {
        return Err(format!(
            "not a GGUF file (magic = {:?})",
            String::from_utf8_lossy(&magic)
        ));
    }

    let version = gguf_read_u32(r).map_err(|e| format!("read version: {e}"))?;
    if version < 2 {
        return Err(format!("GGUF v{version} too old (need >= 2)"));
    }
    let tensor_count = gguf_read_u64(r).map_err(|e| format!("read tcount: {e}"))?;
    let metadata_count = gguf_read_u64(r).map_err(|e| format!("read mcount: {e}"))?;

    let mut out = ParsedMeta {
        version,
        tensor_count,
        metadata_count,
        architecture: None,
        general_name: None,
        chat_template: None,
        numeric: Vec::new(),
    };

    for i in 0..metadata_count {
        let key = gguf_read_string(r).map_err(|e| format!("read kv key at {i}: {e}"))?;
        let ty = gguf_read_u32(r).map_err(|e| format!("read kv type at {i}: {e}"))?;
        match key.as_str() {
            "general.architecture" if ty == 8 => {
                out.architecture =
                    Some(gguf_read_string(r).map_err(|e| format!("read architecture: {e}"))?);
            }
            "general.name" if ty == 8 => {
                out.general_name =
                    Some(gguf_read_string(r).map_err(|e| format!("read general.name: {e}"))?);
            }
            // Capture only the DEFAULT template (exact key). Named variants like
            // `tokenizer.chat_template.tool_use` fall through to skip.
            "tokenizer.chat_template" if ty == 8 => {
                out.chat_template =
                    Some(gguf_read_string(r).map_err(|e| format!("read chat_template: {e}"))?);
            }
            // The leading `.` in every suffix is what keeps neighbours like
            // `deepseek2.leading_dense_block_count` from being mistaken for
            // `{arch}.block_count`.
            k if NUMERIC_KEY_SUFFIXES.iter().any(|s| k.ends_with(s)) => {
                let full = k.to_string();
                if let Some(v) =
                    gguf_read_u64_value(r, ty).map_err(|e| format!("read {full}: {e}"))?
                {
                    out.numeric.push((full, v));
                }
            }
            _ => {
                gguf_skip_value(r, ty).map_err(|e| format!("skip kv {key}: {e}"))?;
            }
        }
    }
    Ok(out)
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

    let parsed = read_header_and_metadata(&mut r)?;
    let tensor_count = parsed.tensor_count;

    // `read_header_and_metadata` leaves the reader on the first tensor
    // descriptor. Enumerate the distinct quant types best-effort — a parse
    // hiccup yields a partial/empty vec, never an error.
    let tensor_types = read_tensor_types(&mut r, tensor_count);

    // Resolve the arch-prefixed numerics now that the whole KV block (and with
    // it `general.architecture`) has been read.
    let arch = parsed.architecture.as_deref();
    let context_length = resolve_meta(&parsed.numeric, arch, ".context_length");
    let block_count = resolve_meta(&parsed.numeric, arch, ".block_count");
    let embedding_length = resolve_meta(&parsed.numeric, arch, ".embedding_length");
    let head_count = resolve_meta(&parsed.numeric, arch, ".attention.head_count");
    let head_count_kv = resolve_meta(&parsed.numeric, arch, ".attention.head_count_kv");
    let key_length = resolve_meta(&parsed.numeric, arch, ".attention.key_length");
    let value_length = resolve_meta(&parsed.numeric, arch, ".attention.value_length");

    let (supports_thinking, thinking_style) = match parsed.chat_template.as_deref() {
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
        gguf_version: parsed.version,
        tensor_count,
        metadata_count: parsed.metadata_count,
        architecture: parsed.architecture,
        general_name: parsed.general_name,
        context_length,
        block_count,
        head_count_kv,
        head_count,
        key_length,
        value_length,
        embedding_length,
        mtp_support,
        size_gb,
        mmproj_siblings,
        supports_thinking,
        thinking_style,
        tensor_types,
    };
    log::info!(
        "inspect_gguf: arch={:?} mtp={} ctx={:?} layers={:?} heads={:?}/{:?}kv kv_dim={:?}/{:?} emb={:?} size={:.2} GB mmproj={} thinking={}({:?}) quants={:?}",
        info.architecture,
        info.mtp_support,
        info.context_length,
        info.block_count,
        info.head_count,
        info.head_count_kv,
        info.key_length,
        info.value_length,
        info.embedding_length,
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

    // ── metadata parse ──────────────────────────────────────────────────────

    fn push_gguf_string(buf: &mut Vec<u8>, s: &str) {
        buf.extend_from_slice(&(s.len() as u64).to_le_bytes());
        buf.extend_from_slice(s.as_bytes());
    }

    /// Build a minimal GGUF header + metadata block: a `general.architecture`
    /// string KV followed by the given u32 KVs (gguf value type 4), then zero
    /// tensor descriptors.
    fn build_gguf(arch: Option<&str>, kvs: &[(&str, u32)]) -> Vec<u8> {
        let mut buf = b"GGUF".to_vec();
        buf.extend_from_slice(&3u32.to_le_bytes()); // version
        buf.extend_from_slice(&0u64.to_le_bytes()); // tensor_count
        let count = kvs.len() as u64 + u64::from(arch.is_some());
        buf.extend_from_slice(&count.to_le_bytes()); // metadata_count
        if let Some(a) = arch {
            push_gguf_string(&mut buf, "general.architecture");
            buf.extend_from_slice(&8u32.to_le_bytes()); // type: string
            push_gguf_string(&mut buf, a);
        }
        for (k, v) in kvs {
            push_gguf_string(&mut buf, k);
            buf.extend_from_slice(&4u32.to_le_bytes()); // type: u32
            buf.extend_from_slice(&v.to_le_bytes());
        }
        buf
    }

    /// Resolve every geometry key for `arch` at once — mirrors what
    /// `inspect_gguf` does after the KV block is read.
    fn geometry(m: &ParsedMeta) -> [Option<u64>; 6] {
        let a = m.architecture.as_deref();
        [
            resolve_meta(&m.numeric, a, ".block_count"),
            resolve_meta(&m.numeric, a, ".attention.head_count"),
            resolve_meta(&m.numeric, a, ".attention.head_count_kv"),
            resolve_meta(&m.numeric, a, ".attention.key_length"),
            resolve_meta(&m.numeric, a, ".attention.value_length"),
            resolve_meta(&m.numeric, a, ".embedding_length"),
        ]
    }

    #[test]
    fn parses_mha_geometry_for_llama() {
        // Llama-2-7B: 32 layers, 32 heads, 32 KV heads (no GQA), no explicit
        // key/value_length — head_dim falls back to 4096 / 32 = 128.
        let buf = build_gguf(
            Some("llama"),
            &[
                ("llama.context_length", 4096),
                ("llama.block_count", 32),
                ("llama.embedding_length", 4096),
                ("llama.attention.head_count", 32),
                ("llama.attention.head_count_kv", 32),
            ],
        );
        let mut c = Cursor::new(buf);
        let m = read_header_and_metadata(&mut c).unwrap();
        assert_eq!(m.architecture.as_deref(), Some("llama"));
        assert_eq!(
            geometry(&m),
            [Some(32), Some(32), Some(32), None, None, Some(4096)]
        );
        assert_eq!(
            resolve_meta(&m.numeric, Some("llama"), ".context_length"),
            Some(4096)
        );
    }

    #[test]
    fn parses_gqa_geometry_for_qwen2() {
        // Qwen2.5-7B: 28 layers, 28 heads but only 4 KV heads, explicit
        // key/value_length. head_count_kv must NOT be swallowed by the
        // `.attention.head_count` suffix.
        let buf = build_gguf(
            Some("qwen2"),
            &[
                ("qwen2.block_count", 28),
                ("qwen2.embedding_length", 3584),
                ("qwen2.attention.head_count", 28),
                ("qwen2.attention.head_count_kv", 4),
                ("qwen2.attention.key_length", 128),
                ("qwen2.attention.value_length", 128),
            ],
        );
        let mut c = Cursor::new(buf);
        let m = read_header_and_metadata(&mut c).unwrap();
        assert_eq!(
            geometry(&m),
            [
                Some(28),
                Some(28),
                Some(4),
                Some(128),
                Some(128),
                Some(3584)
            ]
        );
    }

    #[test]
    fn resolve_meta_prefers_the_declared_architecture() {
        // A vision-bundle GGUF carries a second embedding_length under
        // `clip.vision.` — the text model's must win.
        let buf = build_gguf(
            Some("gemma3"),
            &[
                ("clip.vision.embedding_length", 1152),
                ("clip.vision.block_count", 27),
                ("gemma3.embedding_length", 2560),
                ("gemma3.block_count", 34),
            ],
        );
        let mut c = Cursor::new(buf);
        let m = read_header_and_metadata(&mut c).unwrap();
        assert_eq!(
            resolve_meta(&m.numeric, Some("gemma3"), ".embedding_length"),
            Some(2560)
        );
        assert_eq!(
            resolve_meta(&m.numeric, Some("gemma3"), ".block_count"),
            Some(34)
        );
    }

    #[test]
    fn resolve_meta_falls_back_to_a_unique_suffix_match() {
        // No general.architecture at all: a lone suffix hit still resolves...
        let entries = vec![("mystery.block_count".to_string(), 12u64)];
        assert_eq!(resolve_meta(&entries, None, ".block_count"), Some(12));
        // ...but two competing prefixes are ambiguous, so we report nothing
        // rather than guess which one describes the text model.
        let entries = vec![
            ("clip.vision.block_count".to_string(), 27u64),
            ("mystery.block_count".to_string(), 12u64),
        ];
        assert_eq!(resolve_meta(&entries, None, ".block_count"), None);
    }

    #[test]
    fn read_header_and_metadata_ignores_lookalike_keys() {
        // `leading_dense_block_count` has no dot before `block_count`, so the
        // suffix match must skip it; the real block_count still resolves.
        let buf = build_gguf(
            Some("deepseek2"),
            &[
                ("deepseek2.leading_dense_block_count", 1),
                ("deepseek2.block_count", 61),
            ],
        );
        let mut c = Cursor::new(buf);
        let m = read_header_and_metadata(&mut c).unwrap();
        assert_eq!(m.numeric.len(), 1);
        assert_eq!(
            resolve_meta(&m.numeric, Some("deepseek2"), ".block_count"),
            Some(61)
        );
    }

    #[test]
    fn read_header_and_metadata_rejects_bad_magic() {
        let mut c = Cursor::new(b"NOPE1234".to_vec());
        let err = read_header_and_metadata(&mut c).unwrap_err();
        assert!(err.contains("not a GGUF file"));
    }
}
