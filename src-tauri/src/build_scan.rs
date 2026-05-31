use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use log::{debug, info, warn};
use serde::Serialize;

use crate::util::canonical_dir;

#[derive(Debug, Serialize)]
pub struct DetectedBinary {
    pub name: String,
    pub path: String,
    pub size: String,
    pub ok: bool,
    pub primary: bool,
    pub desc: String,
}

#[derive(Debug, Serialize)]
pub struct BuildInfo {
    pub path: String,
    pub resolved_path: String,
    pub detected: bool,
    pub version: Option<String>,
    pub commit: Option<String>,
    pub backend_badges: Vec<String>,
    pub binaries: Vec<DetectedBinary>,
}

const BINARY_DESCRIPTIONS: &[(&str, &str)] = &[
    ("llama-server", "HTTP/WebSocket server"),
    ("llama-cli", "Interactive REPL"),
    ("llama-mtmd-cli", "Multimodal CLI (audio/image → text)"),
    ("llama-bench", "Throughput benchmark"),
    ("llama-quantize", "Convert / quantize GGUFs"),
    ("llama-perplexity", "Eval perplexity"),
    ("llama-embedding", "Embedding endpoint"),
];

pub fn fmt_size(bytes: u64) -> String {
    if bytes >= 1024 * 1024 * 1024 {
        format!("{:.1} GB", bytes as f64 / 1024.0 / 1024.0 / 1024.0)
    } else if bytes >= 1024 * 1024 {
        format!("{} MB", bytes / 1024 / 1024)
    } else if bytes >= 1024 {
        format!("{} KB", bytes / 1024)
    } else {
        format!("{} B", bytes)
    }
}

fn candidate_subdirs() -> &'static [&'static str] {
    &["", "bin", "bin/Release", "Release"]
}

/// Resolve which subdir of the user-provided path actually contains the
/// binaries. We pick the first subdir that contains llama-server(.exe).
pub fn resolve_bin_dir(root: &Path) -> PathBuf {
    let exe = if cfg!(windows) {
        "llama-server.exe"
    } else {
        "llama-server"
    };
    for sub in candidate_subdirs() {
        let candidate = if sub.is_empty() {
            root.to_path_buf()
        } else {
            root.join(sub)
        };
        if candidate.join(exe).is_file() {
            return candidate;
        }
    }
    root.to_path_buf()
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub fn quiet_command(program: &Path) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn run_version(server_path: &Path) -> Option<(Option<String>, Option<String>, Vec<String>)> {
    let out = quiet_command(server_path)
        .arg("--version")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .ok()?;
    // llama.cpp writes --version output to stderr historically; check both.
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    if text.trim().is_empty() {
        text = String::from_utf8_lossy(&out.stderr).into_owned();
    }

    // Look for "version: bXXXX" or "build = NNNN"
    let mut version = None;
    let mut commit = None;
    for line in text.lines() {
        let l = line.trim();
        if let Some(v) = l.strip_prefix("version:") {
            let v = v.trim();
            // "version: 6841 (10829dbc)"
            let (num, rest) = v.split_once(' ').unwrap_or((v, ""));
            version = Some(format!("b{}", num.trim()));
            if let Some(c) = rest
                .trim()
                .strip_prefix('(')
                .and_then(|s| s.strip_suffix(')'))
            {
                commit = Some(c.to_string());
            }
        } else if let Some(rest) = l.strip_prefix("build:") {
            let rest = rest.trim();
            let (num, paren) = rest.split_once(' ').unwrap_or((rest, ""));
            version = Some(format!("b{}", num.trim()));
            if let Some(c) = paren
                .trim()
                .strip_prefix('(')
                .and_then(|s| s.split_once(')'))
                .map(|(c, _)| c)
            {
                commit = Some(c.to_string());
            }
        }
    }

    let mut badges = Vec::new();
    let lower = text.to_lowercase();
    if lower.contains("cuda") {
        let badge = text
            .lines()
            .find(|l| l.to_lowercase().contains("cuda"))
            .map(|l| l.trim().to_string())
            .unwrap_or_else(|| "CUDA".to_string());
        badges.push(short_backend(&badge, "CUDA"));
    }
    if lower.contains("vulkan") {
        badges.push("Vulkan".into());
    }
    if lower.contains("metal") {
        badges.push("Metal".into());
    }
    if lower.contains("rocm") || lower.contains("hipblas") {
        badges.push("ROCm".into());
    }
    if lower.contains("cublas") {
        badges.push("cuBLAS".into());
    }
    if lower.contains("flash") {
        badges.push("Flash-Attn".into());
    }
    if badges.is_empty() {
        badges.push("CPU".into());
    }

    Some((version, commit, badges))
}

pub fn short_backend(line: &str, default: &str) -> String {
    // Tries to extract e.g. "CUDA 12.4" from a noisier line
    let lower = line.to_lowercase();
    if let Some(idx) = lower.find("cuda") {
        let rest = &line[idx..];
        let head: String = rest.chars().take(20).collect();
        let cut = head.find([',', ')']).unwrap_or(head.len());
        return head[..cut].trim().to_string();
    }
    default.to_string()
}

#[tauri::command]
pub fn scan_build(dir: String) -> Result<BuildInfo, String> {
    info!("scan_build start: {dir}");
    let root = canonical_dir(&dir).map_err(|e| {
        warn!("scan_build: {e}");
        e
    })?;
    let bin_dir = resolve_bin_dir(&root);
    debug!("scan_build resolved bin dir: {}", bin_dir.display());

    let exe_suffix = if cfg!(windows) { ".exe" } else { "" };
    let mut binaries: Vec<DetectedBinary> = Vec::new();

    for (name, desc) in BINARY_DESCRIPTIONS {
        let full = bin_dir.join(format!("{}{}", name, exe_suffix));
        let meta = fs::metadata(&full).ok();
        let ok = meta.is_some();
        let size = meta
            .as_ref()
            .map(|m| fmt_size(m.len()))
            .unwrap_or_else(|| "—".to_string());
        let desc = if ok {
            (*desc).to_string()
        } else {
            format!("Not built — run `cmake --build . --target {}`", name)
        };
        binaries.push(DetectedBinary {
            name: (*name).to_string(),
            path: full.to_string_lossy().into_owned(),
            size,
            ok,
            primary: *name == "llama-server",
            desc,
        });
    }

    let server_path = bin_dir.join(format!("llama-server{}", exe_suffix));
    let detected = server_path.is_file();
    let (version, commit, badges) = if detected {
        run_version(&server_path).unwrap_or((None, None, vec!["CPU".into()]))
    } else {
        (None, None, vec![])
    };

    let info_result = BuildInfo {
        path: dir,
        resolved_path: bin_dir.to_string_lossy().into_owned(),
        detected,
        version,
        commit,
        backend_badges: badges,
        binaries,
    };
    info!(
        "scan_build done: detected={} version={:?} binaries={} backends={:?}",
        info_result.detected,
        info_result.version,
        info_result.binaries.len(),
        info_result.backend_badges,
    );
    Ok(info_result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fmt_size_units() {
        assert_eq!(fmt_size(512), "512 B");
        assert_eq!(fmt_size(2 * 1024), "2 KB");
        assert_eq!(fmt_size(3 * 1024 * 1024), "3 MB");
        assert!(fmt_size(2 * 1024 * 1024 * 1024).starts_with("2.0 GB"));
    }

    #[test]
    fn fmt_size_zero_and_boundaries() {
        assert_eq!(fmt_size(0), "0 B");
        assert_eq!(fmt_size(1023), "1023 B");
        assert_eq!(fmt_size(1024), "1 KB");
    }

    #[test]
    fn short_backend_extracts_cuda_version() {
        // Grabs 20 chars from the first occurrence of "cuda" (case-insensitive),
        // trimmed at the first comma or close paren.
        let s = short_backend("CUDA 12.4, devices = 1", "CUDA");
        assert_eq!(s, "CUDA 12.4");

        // Trims at ')' too.
        let s2 = short_backend("Built with CUDA 12.0)", "CUDA");
        assert_eq!(s2, "CUDA 12.0");

        // Cap at 20 chars when nothing trims earlier.
        let s3 = short_backend("CUDA somelongversion no punct", "CUDA");
        assert!(s3.len() <= 20);
    }

    #[test]
    fn short_backend_falls_back_to_default() {
        assert_eq!(short_backend("nothing here", "Metal"), "Metal");
    }

    #[test]
    fn resolve_bin_dir_returns_root_when_no_candidate_matches() {
        let tmp = std::env::temp_dir();
        let resolved = resolve_bin_dir(&tmp);
        // No `llama-server` exists under tmp on a typical test machine, so the
        // helper should fall back to returning the root unchanged.
        assert_eq!(resolved, tmp);
    }
}
