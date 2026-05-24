use std::fs;

use log::{info, warn};
use serde::Serialize;

use crate::util::canonical_dir;

// Layout expected:  <root>/<owner>/<model>/<file>.gguf
// Quants in the deepest directory are grouped under one model entry.
#[derive(Debug, Serialize)]
pub struct QuantFile {
    pub tag: String,
    pub filename: String,
    pub path: String,
    pub size_gb: f64,
    pub bits: u8,
    pub badges: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct ModelEntry {
    pub name: String,
    pub params: Option<String>,
    pub family: Option<String>,
    pub mtp: bool,
    pub draft: bool,
    pub quants: Vec<QuantFile>,
    /// Sibling mmproj-*.gguf files (multi-modal projectors). Excluded from
    /// `quants`; surface vision capability when present.
    pub mmproj_files: Vec<String>,
}

pub fn is_mmproj_filename(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.starts_with("mmproj") || lower.starts_with("mm-proj")
}

#[derive(Debug, Serialize)]
pub struct OwnerEntry {
    pub owner: String,
    pub models: Vec<ModelEntry>,
}

#[derive(Debug, Serialize)]
pub struct ModelsScan {
    pub path: String,
    pub total_gb: f64,
    pub count: usize,
    pub owners: usize,
    pub tree: Vec<OwnerEntry>,
}

pub fn parse_bits(tag: &str) -> u8 {
    // Q4_K_M → 4; Q8_0-mtp → 8; F16 → 16; otherwise default to 8.
    let t = tag.to_uppercase();
    if t.starts_with('Q') {
        let digits: String = t
            .chars()
            .skip(1)
            .take_while(|c| c.is_ascii_digit())
            .collect();
        if let Ok(n) = digits.parse::<u8>() {
            return n;
        }
    }
    if t.starts_with('F') {
        let digits: String = t
            .chars()
            .skip(1)
            .take_while(|c| c.is_ascii_digit())
            .collect();
        if let Ok(n) = digits.parse::<u8>() {
            return n;
        }
    }
    if t.contains("BF16") {
        return 16;
    }
    if t.contains("IQ4") {
        return 4;
    }
    if t.contains("IQ3") {
        return 3;
    }
    if t.contains("IQ2") {
        return 2;
    }
    8
}

pub fn extract_quant_tag(filename: &str, model_name: &str) -> String {
    // <model>-<tag>.gguf → <tag>
    let mut s = filename.to_string();
    if let Some(rest) = s.strip_suffix(".gguf") {
        s = rest.to_string();
    }
    let prefix = format!("{}-", model_name);
    if let Some(rest) = s.strip_prefix(&prefix) {
        return rest.to_string();
    }
    s.rsplit_once('-')
        .map(|(_, tail)| tail.to_string())
        .unwrap_or(s)
}

pub fn detect_badges(tag: &str, filename: &str) -> (Vec<String>, bool) {
    let mut badges = Vec::new();
    let mut mtp = false;
    let lower = format!("{} {}", tag, filename).to_lowercase();
    if lower.contains("mtp") {
        badges.push("MTP".to_string());
        mtp = true;
    }
    if lower.contains("imatrix") {
        badges.push("imatrix".to_string());
    }
    (badges, mtp)
}

pub fn guess_params(model_name: &str) -> Option<String> {
    // Look for "27B", "8x7B", "1B" etc. in the name
    let upper = model_name.to_uppercase();
    let bytes = upper.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if c.is_ascii_digit() {
            let start = i;
            while i < bytes.len()
                && (bytes[i].is_ascii_digit()
                    || bytes[i] == b'.'
                    || bytes[i] == b'X'
                    || bytes[i] == b'x')
            {
                i += 1;
            }
            if i < bytes.len() && bytes[i] == b'B' {
                let end = i + 1;
                let slice = &upper[start..end];
                return Some(slice.to_string());
            }
        }
        i += 1;
    }
    None
}

pub fn guess_family(model_name: &str) -> Option<String> {
    let lower = model_name.to_lowercase();
    if lower.contains("moe") || lower.contains("mixtral") || lower.contains("8x") {
        Some("MoE".into())
    } else {
        Some("Dense".into())
    }
}

#[tauri::command]
pub fn scan_models(dir: String) -> Result<ModelsScan, String> {
    info!("scan_models start: {dir}");
    let root = canonical_dir(&dir).map_err(|e| {
        warn!("scan_models: {e}");
        e
    })?;
    let mut tree: Vec<OwnerEntry> = Vec::new();
    let mut total_bytes: u64 = 0;
    let mut count: usize = 0;

    let owners = fs::read_dir(&root).map_err(|e| format!("read root: {e}"))?;
    for owner_entry_res in owners {
        let owner_entry = match owner_entry_res {
            Ok(e) => e,
            Err(e) => {
                warn!("scan_models: skipping unreadable entry: {e}");
                continue;
            }
        };
        let owner_path = owner_entry.path();
        if !owner_path.is_dir() {
            continue;
        }
        let owner_name = owner_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if owner_name.starts_with('.') {
            continue;
        }

        let mut owner = OwnerEntry {
            owner: owner_name.clone(),
            models: Vec::new(),
        };

        let models = match fs::read_dir(&owner_path) {
            Ok(m) => m,
            Err(e) => {
                warn!("scan_models: cannot read {}: {e}", owner_path.display());
                continue;
            }
        };
        for model_entry_res in models {
            let model_entry = match model_entry_res {
                Ok(e) => e,
                Err(e) => {
                    warn!("scan_models: skipping unreadable model: {e}");
                    continue;
                }
            };
            let model_path = model_entry.path();
            if !model_path.is_dir() {
                continue;
            }
            let model_name = model_path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            if model_name.starts_with('.') {
                continue;
            }

            // Collect *.gguf in this directory; mmproj files are tracked
            // separately so they don't appear as standalone loadable quants.
            let mut quants: Vec<QuantFile> = Vec::new();
            let mut mmproj_files: Vec<String> = Vec::new();
            let mut model_mtp = false;
            let files = match fs::read_dir(&model_path) {
                Ok(f) => f,
                Err(e) => {
                    warn!("scan_models: cannot read {}: {e}", model_path.display());
                    continue;
                }
            };
            for f_res in files {
                let f = match f_res {
                    Ok(f) => f,
                    Err(e) => {
                        warn!("scan_models: skipping file: {e}");
                        continue;
                    }
                };
                let fp = f.path();
                if !fp.is_file() {
                    continue;
                }
                let fname = fp
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_string();
                if !fname.to_lowercase().ends_with(".gguf") {
                    continue;
                }
                let size = fp.metadata().map(|m| m.len()).unwrap_or(0);
                total_bytes += size;

                if is_mmproj_filename(&fname) {
                    mmproj_files.push(fp.to_string_lossy().into_owned());
                    continue;
                }
                count += 1;

                let tag = extract_quant_tag(&fname, &model_name);
                let bits = parse_bits(&tag);
                let (badges, is_mtp) = detect_badges(&tag, &fname);
                if is_mtp {
                    model_mtp = true;
                }
                quants.push(QuantFile {
                    tag,
                    filename: fname,
                    path: fp.to_string_lossy().into_owned(),
                    size_gb: size as f64 / 1024.0 / 1024.0 / 1024.0,
                    bits,
                    badges,
                });
            }
            if quants.is_empty() {
                continue;
            }
            quants.sort_by(|a, b| a.bits.cmp(&b.bits).then(a.tag.cmp(&b.tag)));
            mmproj_files.sort();

            let draft = model_name.to_lowercase().contains("1b")
                || model_name.to_lowercase().contains("3b")
                || model_name.to_lowercase().contains("0.5b");
            owner.models.push(ModelEntry {
                params: guess_params(&model_name),
                family: guess_family(&model_name),
                name: model_name,
                mtp: model_mtp,
                draft,
                quants,
                mmproj_files,
            });
        }

        if !owner.models.is_empty() {
            owner.models.sort_by(|a, b| a.name.cmp(&b.name));
            tree.push(owner);
        }
    }
    tree.sort_by(|a, b| a.owner.cmp(&b.owner));
    let owners = tree.len();

    let scan = ModelsScan {
        path: dir,
        total_gb: total_bytes as f64 / 1024.0 / 1024.0 / 1024.0,
        count,
        owners,
        tree,
    };
    info!(
        "scan_models done: owners={} models={} total={:.1} GB",
        scan.owners, scan.count, scan.total_gb,
    );
    Ok(scan)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_bits_quant_tags() {
        assert_eq!(parse_bits("Q4_K_M"), 4);
        assert_eq!(parse_bits("Q8_0"), 8);
        assert_eq!(parse_bits("F16"), 16);
        assert_eq!(parse_bits("BF16"), 16);
        assert_eq!(parse_bits("IQ3_S"), 3);
        assert_eq!(parse_bits("IQ2_M"), 2);
        assert_eq!(parse_bits("IQ4_XS"), 4);
    }

    #[test]
    fn parse_bits_unknown_defaults_to_eight() {
        assert_eq!(parse_bits("WeirdTag"), 8);
    }

    #[test]
    fn extract_quant_tag_strips_model_prefix() {
        assert_eq!(
            extract_quant_tag("Qwen-7B-Q4_K_M.gguf", "Qwen-7B"),
            "Q4_K_M"
        );
    }

    #[test]
    fn extract_quant_tag_falls_back_to_last_chunk() {
        assert_eq!(extract_quant_tag("model-x-Q8_0.gguf", "other"), "Q8_0");
    }

    #[test]
    fn extract_quant_tag_handles_missing_dash() {
        assert_eq!(extract_quant_tag("standalone.gguf", "other"), "standalone");
    }

    #[test]
    fn is_mmproj_filename_matches_variants() {
        assert!(is_mmproj_filename("mmproj-vision.gguf"));
        assert!(is_mmproj_filename("mm-proj-foo.gguf"));
        assert!(is_mmproj_filename("MMPROJ-uppercase.gguf"));
        assert!(!is_mmproj_filename("model-mtp.gguf"));
    }

    #[test]
    fn detect_badges_picks_up_mtp_and_imatrix() {
        let (badges, mtp) = detect_badges("Q8_0-MTP", "qwen-mtp.gguf");
        assert!(badges.contains(&"MTP".to_string()));
        assert!(mtp);
        let (badges2, mtp2) = detect_badges("Q4_K_M-imatrix", "model-imatrix.gguf");
        assert!(badges2.contains(&"imatrix".to_string()));
        assert!(!mtp2);
        let (badges3, mtp3) = detect_badges("Q8_0", "plain.gguf");
        assert!(badges3.is_empty());
        assert!(!mtp3);
    }

    #[test]
    fn guess_params_finds_size_with_b_suffix() {
        assert_eq!(guess_params("Qwen-27B-Instruct").as_deref(), Some("27B"));
        assert_eq!(guess_params("Mixtral-8x7B").as_deref(), Some("8X7B"));
        // "3.1" isn't immediately followed by B; scan keeps going until "8B".
        assert_eq!(guess_params("Llama-3.1-8B").as_deref(), Some("8B"));
    }

    #[test]
    fn guess_params_none_for_no_b() {
        assert_eq!(guess_params("just-a-name"), None);
    }

    #[test]
    fn guess_family_detects_moe_keywords() {
        assert_eq!(guess_family("Mixtral-8x7B").as_deref(), Some("MoE"));
        assert_eq!(guess_family("Qwen-MoE").as_deref(), Some("MoE"));
        assert_eq!(guess_family("Qwen-7B").as_deref(), Some("Dense"));
    }
}
