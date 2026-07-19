//! `hipfire diag` integration: a one-shot health/diagnostics page for the
//! hipfire engine, mirroring what Engine manager's llama.cpp build panel
//! shows for that engine.
//!
//! `hipfire diag` takes ~10s (it does a live HIP GPU probe), so the command
//! is `async fn` — same rationale as `list_hipfire_models`/
//! `list_hipfire_available`: a sync `#[tauri::command]` would block the main
//! (STA) thread for the whole probe. No streaming needed (unlike
//! pull/convert/bench) — it's a single `Command::output()` call.
//!
//! `parse_hipfire_diag` is a pure text scraper, unit-tested against the
//! live-captured fixture (2026-07-19, fact 2) plus a fixture with the GPU
//! probe section entirely absent (e.g. Linux without HIP, or hipcc/rocminfo
//! both missing) — it must never panic on a partial/garbled capture.

use std::path::PathBuf;
use std::process::Stdio;

use serde::Serialize;

use crate::build_scan::quiet_command;
use crate::server::resolve_hipfire_bin;

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
pub struct HipfireDiagLocalModel {
    pub name: String,
    pub size: String,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
pub struct HipfireDiagKernelArch {
    pub arch: String,
    pub blobs: u32,
    pub hashes: u32,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
pub struct HipfireDiagGpu {
    pub arch: Option<String>,
    pub hip_version: Option<String>,
    pub vram_free_mb: Option<u64>,
    pub vram_total_mb: Option<u64>,
    pub kv_default: Option<String>,
    pub wmma: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
pub struct HipfireDiag {
    pub daemon_found: Option<bool>,
    pub local_models: Vec<HipfireDiagLocalModel>,
    /// Per-arch kernel blob counts — only entries with `blobs > 0` are kept
    /// (the raw output lists every known arch, most with 0 blobs/0 hashes,
    /// which carries no information for the health page).
    pub kernels: Vec<HipfireDiagKernelArch>,
    /// `None` when the GPU probe section is missing from the output entirely
    /// (e.g. probe failed, or a platform where it's skipped).
    pub gpu: Option<HipfireDiagGpu>,
    pub config_path: Option<String>,
    /// `key = value` lines under the `config:` block, in the order they
    /// appeared.
    pub config: Vec<(String, String)>,
}

/// Result of the `hipfire_diag` command: the parsed page plus the full raw
/// text, so the frontend can offer a "raw output" fallback without a second
/// round trip.
#[derive(Debug, Clone, Serialize)]
pub struct HipfireDiagResult {
    pub output: String,
    pub diag: HipfireDiag,
}

fn parse_leading_u64(s: &str) -> Option<u64> {
    let digits: String = s.trim().chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        None
    } else {
        digits.parse().ok()
    }
}

/// Parse `hipfire diag`'s text output into a structured page. Pure — no
/// process spawning. Every field is best-effort: a missing/garbled section
/// just leaves the corresponding field at its default rather than failing
/// the whole parse, so a partial/garbled capture never panics.
pub fn parse_hipfire_diag(output: &str) -> HipfireDiag {
    let mut diag = HipfireDiag::default();
    let mut gpu = HipfireDiagGpu::default();
    let mut have_gpu = false;
    let mut in_local_models = false;
    let mut in_config = false;

    for line in output.lines() {
        let trimmed = line.trim();

        if let Some(v) = trimmed.strip_prefix("daemon:") {
            diag.daemon_found = Some(v.trim().eq_ignore_ascii_case("found"));
            in_local_models = false;
            in_config = false;
            continue;
        }

        if trimmed.starts_with("local models:") {
            in_local_models = true;
            in_config = false;
            continue;
        }
        if in_local_models {
            if line.starts_with(' ') && !trimmed.is_empty() {
                let mut parts = trimmed.split_whitespace();
                if let (Some(name), Some(size)) = (parts.next(), parts.next()) {
                    diag.local_models.push(HipfireDiagLocalModel {
                        name: name.to_string(),
                        size: size.to_string(),
                    });
                }
                continue;
            }
            in_local_models = false;
            // Fall through — this line may still match something else below.
        }

        if let Some(rest) = trimmed.strip_prefix("kernels/") {
            if let Some((arch, tail)) = rest.split_once(':') {
                let nums: Vec<u32> = tail
                    .split(|c: char| !c.is_ascii_digit())
                    .filter(|s| !s.is_empty())
                    .filter_map(|s| s.parse().ok())
                    .collect();
                if let Some(&blobs) = nums.first() {
                    if blobs > 0 {
                        let hashes = nums.get(1).copied().unwrap_or(0);
                        diag.kernels.push(HipfireDiagKernelArch {
                            arch: arch.to_string(),
                            blobs,
                            hashes,
                        });
                    }
                }
            }
            continue;
        }

        if let Some(v) = trimmed.strip_prefix("GPU arch:") {
            gpu.arch = Some(v.trim().to_string());
            have_gpu = true;
            continue;
        }
        if let Some(v) = trimmed.strip_prefix("HIP version:") {
            gpu.hip_version = Some(v.trim().to_string());
            have_gpu = true;
            continue;
        }
        if let Some(v) = trimmed.strip_prefix("VRAM free:") {
            gpu.vram_free_mb = parse_leading_u64(v);
            have_gpu = true;
            continue;
        }
        if let Some(v) = trimmed.strip_prefix("VRAM total:") {
            gpu.vram_total_mb = parse_leading_u64(v);
            have_gpu = true;
            continue;
        }
        if let Some(v) = trimmed.strip_prefix("kv default:") {
            gpu.kv_default = Some(v.trim().to_string());
            have_gpu = true;
            continue;
        }
        if let Some(v) = trimmed.strip_prefix("WMMA:") {
            gpu.wmma = Some(v.trim().to_string());
            have_gpu = true;
            continue;
        }

        if let Some(v) = trimmed.strip_prefix("config:") {
            let v = v.trim();
            if !v.is_empty() {
                diag.config_path = Some(v.to_string());
                in_config = true;
            }
            continue;
        }
        if in_config {
            if line.starts_with(' ') && trimmed.contains('=') {
                if let Some((k, v)) = trimmed.split_once('=') {
                    diag.config.push((k.trim().to_string(), v.trim().to_string()));
                }
                continue;
            } else if !trimmed.is_empty() {
                in_config = false;
            }
        }
    }

    if have_gpu {
        diag.gpu = Some(gpu);
    }
    diag
}

/// Run `<hipfire> diag` and parse it. `async fn` — the live HIP GPU probe
/// takes ~10s; a sync command would stall the main thread (settings writes,
/// server-status polling) for that whole window.
#[tauri::command]
pub async fn hipfire_diag(explicit: Option<String>) -> Result<HipfireDiagResult, String> {
    let bin = resolve_hipfire_bin(explicit.as_deref().unwrap_or(""))?;
    let work_dir = bin
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    let out = quiet_command(&bin)
        .arg("diag")
        .current_dir(&work_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("spawn hipfire diag: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("hipfire diag failed: {}", stderr.trim()));
    }
    let output = String::from_utf8_lossy(&out.stdout).into_owned();
    let diag = parse_hipfire_diag(&output);
    Ok(HipfireDiagResult { output, diag })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Verbatim capture from `hipfire diag` (exit 0, ~10s), 2026-07-19 live
    // capture, fact 2. A handful of the ~11 zero-blob kernel arch lines are
    // included to prove they're filtered out. A raw string with real line
    // breaks (NOT `\n\` continuations, which eat the following line's leading
    // whitespace and would silently destroy the two-space indentation the
    // parser keys off of).
    const FIXTURE: &str = r"hipfire diagnostics
registry:      cache
platform:      Windows (native)
hipcc:         NOT FOUND
rocminfo:      NOT FOUND
daemon:        found
local models:  2
  qwen3.6-27b.mq4                     15.0GB
  qwen36-27b-dflash-mq4.hfq            0.9GB
kernels/gfx1201: 48 blobs, 48 hashes
kernels/gfx900: 0 blobs, 0 hashes
kernels/gfx906: 0 blobs, 0 hashes
kernels/gfx1100: 0 blobs, 0 hashes
Probing GPU via HIP runtime...
GPU dev 0: gfx1201 (34.2 GB VRAM, HIP 7.13)
  pre-compiled kernels: .hipfire_kernels\gfx1201
  GPU arch:    gfx1201
  HIP version: 7.13
  VRAM free:   32473 MB
  VRAM total:  32624 MB
  kv default:  q8 (auto -> registry default_kv_mode, else q8)
  WMMA:        yes (4.1x prefill)
config:        C:\Users\pay20\.hipfire\config.json
  default_model = qwen3.6:27b
  max_tokens = 512
  dflash_mode = auto
Done.
";

    #[test]
    fn parses_daemon_status() {
        let d = parse_hipfire_diag(FIXTURE);
        assert_eq!(d.daemon_found, Some(true));
    }

    #[test]
    fn parses_local_models() {
        let d = parse_hipfire_diag(FIXTURE);
        assert_eq!(
            d.local_models,
            vec![
                HipfireDiagLocalModel {
                    name: "qwen3.6-27b.mq4".into(),
                    size: "15.0GB".into(),
                },
                HipfireDiagLocalModel {
                    name: "qwen36-27b-dflash-mq4.hfq".into(),
                    size: "0.9GB".into(),
                },
            ]
        );
    }

    #[test]
    fn keeps_only_nonzero_kernel_arches() {
        let d = parse_hipfire_diag(FIXTURE);
        assert_eq!(
            d.kernels,
            vec![HipfireDiagKernelArch {
                arch: "gfx1201".into(),
                blobs: 48,
                hashes: 48,
            }]
        );
    }

    #[test]
    fn parses_the_gpu_probe_block() {
        let d = parse_hipfire_diag(FIXTURE);
        let gpu = d.gpu.expect("gpu probe present");
        assert_eq!(gpu.arch.as_deref(), Some("gfx1201"));
        assert_eq!(gpu.hip_version.as_deref(), Some("7.13"));
        assert_eq!(gpu.vram_free_mb, Some(32473));
        assert_eq!(gpu.vram_total_mb, Some(32624));
        assert!(gpu.kv_default.as_deref().unwrap().starts_with("q8"));
        assert!(gpu.wmma.as_deref().unwrap().starts_with("yes"));
    }

    #[test]
    fn parses_config_path_and_kv_lines() {
        let d = parse_hipfire_diag(FIXTURE);
        assert_eq!(
            d.config_path.as_deref(),
            Some("C:\\Users\\pay20\\.hipfire\\config.json")
        );
        assert_eq!(
            d.config,
            vec![
                ("default_model".to_string(), "qwen3.6:27b".to_string()),
                ("max_tokens".to_string(), "512".to_string()),
                ("dflash_mode".to_string(), "auto".to_string()),
            ]
        );
    }

    #[test]
    fn gpu_probe_missing_yields_none_without_panicking() {
        // hipcc/rocminfo both missing AND the HIP probe itself unavailable
        // (e.g. a headless Linux box with no ROCm) — the GPU section never
        // appears at all.
        let output = r"hipfire diagnostics
registry:      cache
platform:      Linux (native)
hipcc:         NOT FOUND
rocminfo:      NOT FOUND
daemon:        found
local models:  0
kernels/gfx1201: 0 blobs, 0 hashes
config:        /home/user/.hipfire/config.json
  default_model = qwen3.6:27b
Done.
";
        let d = parse_hipfire_diag(output);
        assert!(d.gpu.is_none());
        assert!(d.kernels.is_empty());
        assert!(d.local_models.is_empty());
        assert_eq!(d.daemon_found, Some(true));
        assert_eq!(
            d.config,
            vec![("default_model".to_string(), "qwen3.6:27b".to_string())]
        );
    }

    #[test]
    fn empty_output_yields_all_defaults_without_panicking() {
        let d = parse_hipfire_diag("");
        assert_eq!(d, HipfireDiag::default());
    }

    #[test]
    fn garbage_output_yields_defaults_without_panicking() {
        let d = parse_hipfire_diag("???\nnot even close\n\t\t\n12345\n=====\n");
        assert_eq!(d, HipfireDiag::default());
    }

    #[test]
    fn daemon_not_found_parses_false() {
        let d = parse_hipfire_diag("daemon:        NOT FOUND\n");
        assert_eq!(d.daemon_found, Some(false));
    }
}
