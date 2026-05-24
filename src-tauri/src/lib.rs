mod mcp;

use std::collections::VecDeque;
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use log::{debug, error, info, warn};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sysinfo::System;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::mcp::{McpRegistry, McpServerConfig, McpStatus, McpTool};

// Mutex helper that recovers from poison rather than panicking. A poisoned
// mutex means a thread panicked while holding the lock, but the data inside
// is usually still consistent for our use cases (process state, sysinfo
// cache). We log and continue instead of taking down the app.
fn lock_or_poisoned<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| {
        log::error!("mutex poisoned, recovering inner state");
        p.into_inner()
    })
}

// Canonicalize a user-supplied directory string and verify it resolves to a
// directory. Rejects non-existent paths and any path traversal escapes that
// would resolve outside the expected tree (we don't whitelist a parent here —
// we just refuse symlink chains that don't ultimately point at a directory).
fn canonical_dir(input: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(input);
    let canonical = fs::canonicalize(&p).map_err(|e| format!("canonicalize {input}: {e}"))?;
    if !canonical.is_dir() {
        return Err(format!("not a directory: {}", canonical.display()));
    }
    Ok(canonical)
}

// ── Settings ────────────────────────────────────────────────────────────────
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default)]
    pub build_dir: Option<String>,
    #[serde(default)]
    pub recent_dirs: Vec<String>,
    #[serde(default)]
    pub model_path: Option<String>,
    #[serde(default)]
    pub flags: serde_json::Value,
    #[serde(default)]
    pub models_dir: Option<String>,
    #[serde(default)]
    pub models_recent: Vec<String>,
    #[serde(default)]
    pub profiles: Vec<SavedProfile>,
    /// Toggles the `enable_thinking` chat_template_kwarg on outbound requests.
    /// None == use default (true) so older settings files still work.
    #[serde(default)]
    pub reasoning_enabled: Option<bool>,
    /// User-registered MCP servers.
    #[serde(default)]
    pub mcp_servers: Vec<McpServerConfig>,
    /// Reusable chat session presets (system prompt, MCP toggles, etc.).
    #[serde(default)]
    pub chat_presets: Vec<ChatPreset>,
}

/// Reusable bundle of per-session chat configuration. Saved at the top level
/// so a user can apply the same setup to multiple sessions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatPreset {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    #[serde(default)]
    pub config: ChatSessionConfig,
}

/// Per-session chat config. Stored on each ChatSession when overridden.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ChatSessionConfig {
    #[serde(default)]
    pub system_prompt: Option<String>,
    /// Optional client-side chat template override. When present, requests
    /// include `chat_template` so llama-server uses it instead of the
    /// model-default template.
    #[serde(default)]
    pub chat_template: Option<String>,
    /// IDs of MCP servers enabled for this session. Tools are pulled from
    /// these servers and offered to the model.
    #[serde(default)]
    pub mcp_server_ids: Vec<String>,
    /// Default tool-permission policy and per-tool overrides.
    #[serde(default)]
    pub tool_permissions: ToolPermissions,
    /// If this session was hydrated from a preset, remember the preset id so
    /// the UI can show "linked" state.
    #[serde(default)]
    pub preset_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolPermissions {
    /// One of: "allow" | "ask" | "deny"
    #[serde(default = "default_policy")]
    pub default: String,
    /// "<serverId>:<toolName>" → policy. Falls back to `default` if missing.
    #[serde(default)]
    pub per_tool: std::collections::HashMap<String, String>,
}

impl Default for ToolPermissions {
    fn default() -> Self {
        Self {
            default: default_policy(),
            per_tool: Default::default(),
        }
    }
}

fn default_policy() -> String {
    "ask".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedProfile {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub flags: serde_json::Value,
    #[serde(default)]
    pub model_path: Option<String>,
    #[serde(default)]
    pub agency: Option<String>,
}

impl Settings {
    fn _ensure_defaults(&mut self) {
        // Placeholder for future migration logic.
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    Ok(dir.join("settings.json"))
}

#[tauri::command]
fn load_settings(app: AppHandle) -> Result<Settings, String> {
    let p = settings_path(&app)?;
    if !p.exists() {
        info!("settings: no existing file at {}", p.display());
        return Ok(Settings::default());
    }
    let s = fs::read_to_string(&p).map_err(|e| {
        error!("settings read failed: {e}");
        format!("read: {e}")
    })?;
    let parsed: Settings = serde_json::from_str(&s).map_err(|e| {
        error!("settings parse failed: {e}");
        format!("parse: {e}")
    })?;
    info!(
        "settings loaded ({} bytes, {} profiles, {} recent build dirs, {} recent models dirs)",
        s.len(),
        parsed.profiles.len(),
        parsed.recent_dirs.len(),
        parsed.models_recent.len(),
    );
    Ok(parsed)
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    let p = settings_path(&app)?;
    let s = serde_json::to_string_pretty(&settings).map_err(|e| {
        error!("settings encode failed: {e}");
        format!("encode: {e}")
    })?;
    fs::write(&p, &s).map_err(|e| {
        error!("settings write failed: {e}");
        format!("write: {e}")
    })?;
    debug!("settings saved ({} bytes)", s.len());
    Ok(())
}

// ── Build directory scan ────────────────────────────────────────────────────
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
    ("llama-bench", "Throughput benchmark"),
    ("llama-quantize", "Convert / quantize GGUFs"),
    ("llama-perplexity", "Eval perplexity"),
    ("llama-embedding", "Embedding endpoint"),
];

fn fmt_size(bytes: u64) -> String {
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

// Resolve which subdir of the user-provided path actually contains the binaries.
// We pick the first subdir that contains llama-server(.exe).
fn resolve_bin_dir(root: &Path) -> PathBuf {
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

fn quiet_command(program: &Path) -> Command {
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

    // Best-effort backend badges from the version output
    let mut badges = Vec::new();
    let lower = text.to_lowercase();
    if lower.contains("cuda") {
        // Try to pick the version number after CUDA
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

fn short_backend(line: &str, default: &str) -> String {
    // Tries to extract e.g. "CUDA 12.4" from a noisier line
    let lower = line.to_lowercase();
    if let Some(idx) = lower.find("cuda") {
        let rest = &line[idx..];
        let head: String = rest.chars().take(20).collect();
        // Trim to first comma/paren
        let cut = head.find([',', ')']).unwrap_or(head.len());
        return head[..cut].trim().to_string();
    }
    default.to_string()
}

#[tauri::command]
fn scan_build(dir: String) -> Result<BuildInfo, String> {
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

// ── Native pickers ─────────────────────────────────────────────────────────
// The dialog plugin's JS API does folder/file picking directly, so we don't
// re-expose it here. The frontend calls `@tauri-apps/plugin-dialog` directly.

// ── Models library scan ─────────────────────────────────────────────────────
//
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

fn is_mmproj_filename(name: &str) -> bool {
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

fn parse_bits(tag: &str) -> u8 {
    // Q4_K_M → 4; Q8_0-mtp → 8; F16 → 16; otherwise 0 (unknown)
    let t = tag.to_uppercase();
    if t.starts_with('Q') {
        // grab digits after Q
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

fn extract_quant_tag(filename: &str, model_name: &str) -> String {
    // <model>-<tag>.gguf → <tag>
    // Try to strip "<model_name>-" prefix and ".gguf" suffix.
    let mut s = filename.to_string();
    if let Some(rest) = s.strip_suffix(".gguf") {
        s = rest.to_string();
    }
    let prefix = format!("{}-", model_name);
    if let Some(rest) = s.strip_prefix(&prefix) {
        return rest.to_string();
    }
    // No match: use the last dash-separated chunk
    s.rsplit_once('-')
        .map(|(_, tail)| tail.to_string())
        .unwrap_or(s)
}

fn detect_badges(tag: &str, filename: &str) -> (Vec<String>, bool) {
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

fn guess_params(model_name: &str) -> Option<String> {
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

fn guess_family(model_name: &str) -> Option<String> {
    let lower = model_name.to_lowercase();
    if lower.contains("moe") || lower.contains("mixtral") || lower.contains("8x") {
        Some("MoE".into())
    } else {
        Some("Dense".into())
    }
}

#[tauri::command]
fn scan_models(dir: String) -> Result<ModelsScan, String> {
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
            // Sort quants by bit depth ascending so the lightest comes first.
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
            // Sort models alphabetically within an owner
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

// ── GGUF inspector ──────────────────────────────────────────────────────────
// Parses just enough of a GGUF file to expose: architecture, name, version,
// tensor count, and whether the file contains MTP head tensors. Reads only
// the metadata + tensor-info block at the start of the file (typically well
// under 1 MB), not the weight payload.
//
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
    pub mtp_support: bool,
    pub size_gb: f64,
    /// Sibling mmproj-*.gguf files in the same directory as this model.
    /// Lets the UI auto-set `--mmproj` for vision-capable bundles.
    pub mmproj_siblings: Vec<String>,
}

fn gguf_read_u32<R: Read>(r: &mut R) -> io::Result<u32> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b)?;
    Ok(u32::from_le_bytes(b))
}

fn gguf_read_u64<R: Read>(r: &mut R) -> io::Result<u64> {
    let mut b = [0u8; 8];
    r.read_exact(&mut b)?;
    Ok(u64::from_le_bytes(b))
}

fn gguf_read_string<R: Read>(r: &mut R) -> io::Result<String> {
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

fn gguf_skip_value<R: Read + Seek>(r: &mut R, ty: u32) -> io::Result<()> {
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

fn gguf_read_u64_value<R: Read + Seek>(r: &mut R, ty: u32) -> io::Result<Option<u64>> {
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
fn inspect_gguf(path: String) -> Result<GgufInfo, String> {
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
            k if k.ends_with(".context_length") => {
                context_length = gguf_read_u64_value(&mut r, ty)
                    .map_err(|e| format!("read context_length: {e}"))?;
            }
            _ => {
                gguf_skip_value(&mut r, ty).map_err(|e| format!("skip kv {key}: {e}"))?;
            }
        }
    }

    // MTP support is signalled by an "-MTP" token in the filename (case-
    // insensitive). Cheaper and just as reliable as scanning the tensor table,
    // since this is how upstream model authors actually mark MTP-capable GGUFs.
    let mtp_support = p
        .file_name()
        .and_then(|s| s.to_str())
        .map(|n| n.to_lowercase().contains("-mtp"))
        .unwrap_or(false);

    // Find sibling mmproj-*.gguf files in the same directory.
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
        mtp_support,
        size_gb,
        mmproj_siblings,
    };
    log::info!(
        "inspect_gguf: arch={:?} mtp={} ctx={:?} size={:.2} GB mmproj={}",
        info.architecture,
        info.mtp_support,
        info.context_length,
        info.size_gb,
        info.mmproj_siblings.len(),
    );
    Ok(info)
}

// ── WMI GPU performance counters (Windows) ─────────────────────────────────
// Vendor-neutral utilization via the same perf counters Task Manager uses.
// Provides util% only — no temp/power/clocks.
#[cfg(windows)]
mod gpu_perf {
    use serde::Deserialize;
    use std::collections::HashMap;
    use wmi::{COMLibrary, WMIConnection};

    #[derive(Deserialize, Debug)]
    #[serde(rename_all = "PascalCase")]
    struct GpuEngine {
        name: String,
        utilization_percentage: u64,
    }

    /// Returns a map of LUID-token → highest engine utilization (%) seen for
    /// that physical adapter. Empty on any failure (WMI unavailable, query
    /// rejected, etc.).
    pub fn query_util_by_luid() -> HashMap<String, u32> {
        let com = match COMLibrary::new() {
            Ok(c) => c,
            Err(e) => {
                log::debug!("wmi: COM init failed: {e}");
                return HashMap::new();
            }
        };
        let wmi = match WMIConnection::new(com) {
            Ok(w) => w,
            Err(e) => {
                log::debug!("wmi: connection failed: {e}");
                return HashMap::new();
            }
        };
        let rows: Vec<GpuEngine> = match wmi.raw_query(
            "SELECT Name, UtilizationPercentage \
             FROM Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine",
        ) {
            Ok(r) => r,
            Err(e) => {
                log::debug!("wmi: GPUEngine query failed: {e}");
                return HashMap::new();
            }
        };
        let mut by_luid: HashMap<String, u32> = HashMap::new();
        for row in rows {
            // Name format: "pid_XXXX_luid_0xXXXXXXXX_0xXXXXXXXX_phys_X_eng_X_engtype_3D"
            // Group by the LUID portion (which identifies a physical adapter).
            if let Some(luid) = extract_luid(&row.name) {
                let entry = by_luid.entry(luid).or_insert(0);
                let v = row.utilization_percentage as u32;
                if v > *entry {
                    *entry = v;
                }
            }
        }
        by_luid
    }

    fn extract_luid(name: &str) -> Option<String> {
        let start = name.find("luid_")?;
        let rest = &name[start..];
        let end = rest.find("_phys_").unwrap_or(rest.len());
        Some(rest[..end].to_string())
    }
}

// ── HIP runtime (AMD) ───────────────────────────────────────────────────────
// Dynamically loads amdhip64_7.dll (or older variants) for AMD GPU detection.
// Only used as a fallback when NVML reports zero NVIDIA devices.
#[cfg(windows)]
mod hip {
    use libloading::{Library, Symbol};
    use std::ffi::{c_char, CStr};
    use std::path::Path;

    pub type HipError = i32;
    pub type HipDevice = i32;
    const HIP_SUCCESS: HipError = 0;

    pub struct HipRuntime {
        _lib: Library,
        get_device_count: unsafe extern "C" fn(count: *mut i32) -> HipError,
        device_get_name:
            unsafe extern "C" fn(name: *mut c_char, len: i32, device: HipDevice) -> HipError,
        device_total_mem: unsafe extern "C" fn(total: *mut usize, device: HipDevice) -> HipError,
        set_device: unsafe extern "C" fn(device: HipDevice) -> HipError,
        mem_get_info: unsafe extern "C" fn(free: *mut usize, total: *mut usize) -> HipError,
    }

    // libloading::Library on Windows uses LoadLibrary, which is thread-safe.
    // Function pointers are inherently Send+Sync. Mark explicitly so we can
    // wrap in Arc<Mutex<...>>.
    unsafe impl Send for HipRuntime {}
    unsafe impl Sync for HipRuntime {}

    pub struct DeviceInfo {
        pub name: String,
        pub vram_total: usize,
        pub vram_free: usize,
    }

    impl HipRuntime {
        const DLL_NAMES: &'static [&'static str] =
            &["amdhip64_7.dll", "amdhip64_6.dll", "amdhip64.dll"];

        pub fn try_open(search_dirs: &[&Path]) -> Option<Self> {
            let mut lib: Option<Library> = None;
            for name in Self::DLL_NAMES {
                // Try system PATH first
                unsafe {
                    if let Ok(l) = Library::new(name) {
                        log::info!("hip: loaded {name} from system PATH");
                        lib = Some(l);
                        break;
                    }
                }
                // Then any hint directories
                for d in search_dirs {
                    let p = d.join(name);
                    if p.is_file() {
                        unsafe {
                            match Library::new(&p) {
                                Ok(l) => {
                                    log::info!("hip: loaded {}", p.display());
                                    lib = Some(l);
                                    break;
                                }
                                Err(e) => log::warn!("hip: failed to load {}: {e}", p.display()),
                            }
                        }
                    }
                }
                if lib.is_some() {
                    break;
                }
            }
            let lib = lib?;
            unsafe {
                let s_get_device_count: Symbol<unsafe extern "C" fn(*mut i32) -> HipError> =
                    lib.get(b"hipGetDeviceCount\0").ok()?;
                let s_device_get_name: Symbol<
                    unsafe extern "C" fn(*mut c_char, i32, HipDevice) -> HipError,
                > = lib.get(b"hipDeviceGetName\0").ok()?;
                let s_device_total_mem: Symbol<
                    unsafe extern "C" fn(*mut usize, HipDevice) -> HipError,
                > = lib.get(b"hipDeviceTotalMem\0").ok()?;
                let s_set_device: Symbol<unsafe extern "C" fn(HipDevice) -> HipError> =
                    lib.get(b"hipSetDevice\0").ok()?;
                let s_mem_get_info: Symbol<
                    unsafe extern "C" fn(*mut usize, *mut usize) -> HipError,
                > = lib.get(b"hipMemGetInfo\0").ok()?;

                // Copy out the raw function pointers, then let the Symbol
                // borrows go out of scope naturally — the explicit drop()s
                // here were no-ops since Symbol doesn't implement Drop.
                let get_device_count = *s_get_device_count;
                let device_get_name = *s_device_get_name;
                let device_total_mem = *s_device_total_mem;
                let set_device = *s_set_device;
                let mem_get_info = *s_mem_get_info;

                // Optional: hipInit(0). Some runtimes auto-init; we tolerate
                // either presence or absence.
                if let Ok(init) = lib.get::<unsafe extern "C" fn(u32) -> HipError>(b"hipInit\0") {
                    let rc = init(0);
                    if rc != HIP_SUCCESS {
                        log::warn!("hip: hipInit returned {rc} (continuing)");
                    }
                }

                Some(HipRuntime {
                    _lib: lib,
                    get_device_count,
                    device_get_name,
                    device_total_mem,
                    set_device,
                    mem_get_info,
                })
            }
        }

        pub fn device_count(&self) -> i32 {
            let mut n: i32 = 0;
            unsafe {
                if (self.get_device_count)(&mut n) == HIP_SUCCESS {
                    n.max(0)
                } else {
                    0
                }
            }
        }

        pub fn device_info(&self, idx: HipDevice) -> Option<DeviceInfo> {
            let mut name_buf = [0u8; 256];
            unsafe {
                let rc = (self.device_get_name)(
                    name_buf.as_mut_ptr() as *mut c_char,
                    name_buf.len() as i32,
                    idx,
                );
                if rc != HIP_SUCCESS {
                    return None;
                }
                let name = CStr::from_ptr(name_buf.as_ptr() as *const c_char)
                    .to_string_lossy()
                    .into_owned();

                let mut total: usize = 0;
                let _ = (self.device_total_mem)(&mut total, idx);

                let mut free: usize = 0;
                if (self.set_device)(idx) == HIP_SUCCESS {
                    let mut free_buf: usize = 0;
                    let mut total_buf: usize = 0;
                    if (self.mem_get_info)(&mut free_buf, &mut total_buf) == HIP_SUCCESS {
                        free = free_buf;
                        if total == 0 {
                            total = total_buf;
                        }
                    }
                }
                Some(DeviceInfo {
                    name,
                    vram_total: total,
                    vram_free: free,
                })
            }
        }
    }
}

// ── Hardware snapshot ───────────────────────────────────────────────────────
#[derive(Debug, Serialize, Clone)]
pub struct GpuInfo {
    pub name: String,
    pub vram_total_gb: f64,
    pub vram_used_gb: f64,
    pub util: Option<u32>,
    pub temp_c: Option<u32>,
    pub power_w: Option<u32>,
    pub clock_mhz: Option<u32>,
}

#[derive(Debug, Serialize, Clone)]
pub struct HwSnapshot {
    pub cpu_util: f32,
    pub cpu_name: String,
    pub cpu_cores: usize,
    pub cpu_freq_ghz: f32,
    pub ram_total_gb: f64,
    pub ram_used_gb: f64,
    pub swap_used_gb: f64,
    pub gpus: Vec<GpuInfo>,
    pub gpu_backend: &'static str,
}

pub struct HwState {
    pub sys: Mutex<System>,
    #[cfg(feature = "nvml")]
    pub nvml: std::sync::OnceLock<Option<nvml_wrapper::Nvml>>,
    #[cfg(windows)]
    pub hip: Mutex<Option<std::sync::Arc<hip::HipRuntime>>>,
    pub build_dir_hint: Mutex<Option<String>>,
}

#[tauri::command]
fn hw_snapshot(state: State<'_, HwState>) -> HwSnapshot {
    let mut sys = lock_or_poisoned(&state.sys);
    sys.refresh_cpu_usage();
    sys.refresh_memory();

    let cpu_util = sys.global_cpu_usage();
    let cpus = sys.cpus();
    let cpu_name = cpus
        .first()
        .map(|c| c.brand().to_string())
        .unwrap_or_default();
    let cpu_freq_ghz = cpus
        .first()
        .map(|c| c.frequency() as f32 / 1000.0)
        .unwrap_or(0.0);
    let cpu_cores = cpus.len();
    let ram_total_gb = sys.total_memory() as f64 / 1024.0 / 1024.0 / 1024.0;
    let ram_used_gb = sys.used_memory() as f64 / 1024.0 / 1024.0 / 1024.0;
    let swap_used_gb = sys.used_swap() as f64 / 1024.0 / 1024.0 / 1024.0;

    let (gpus, backend) = read_gpus(&state);

    HwSnapshot {
        cpu_util,
        cpu_name,
        cpu_cores,
        cpu_freq_ghz,
        ram_total_gb,
        ram_used_gb,
        swap_used_gb,
        gpus,
        gpu_backend: backend,
    }
}

fn read_gpus(state: &State<'_, HwState>) -> (Vec<GpuInfo>, &'static str) {
    // ── NVIDIA first (NVML) ────────────────────────────────────────────────
    #[cfg(feature = "nvml")]
    {
        let nvml_slot = state.nvml.get_or_init(|| nvml_wrapper::Nvml::init().ok());
        if let Some(nvml) = nvml_slot {
            let count = nvml.device_count().unwrap_or(0);
            let mut out = Vec::new();
            for i in 0..count {
                if let Ok(d) = nvml.device_by_index(i) {
                    let name = d.name().unwrap_or_else(|_| "GPU".into());
                    let mem = d.memory_info().ok();
                    let util = d.utilization_rates().ok();
                    let temp = d
                        .temperature(nvml_wrapper::enum_wrappers::device::TemperatureSensor::Gpu)
                        .ok();
                    let power = d.power_usage().ok().map(|w| w / 1000);
                    let clock = d
                        .clock_info(nvml_wrapper::enum_wrappers::device::Clock::Graphics)
                        .ok();
                    out.push(GpuInfo {
                        name,
                        vram_total_gb: mem
                            .as_ref()
                            .map(|m| m.total as f64 / 1024.0 / 1024.0 / 1024.0)
                            .unwrap_or(0.0),
                        vram_used_gb: mem
                            .as_ref()
                            .map(|m| m.used as f64 / 1024.0 / 1024.0 / 1024.0)
                            .unwrap_or(0.0),
                        util: util.map(|u| u.gpu),
                        temp_c: temp,
                        power_w: power,
                        clock_mhz: clock,
                    });
                }
            }
            if !out.is_empty() {
                return (out, "NVML");
            }
        }
    }

    // ── AMD via HIP (Windows only) ─────────────────────────────────────────
    #[cfg(windows)]
    {
        // Try to load the HIP runtime, caching the result on success. On
        // failure we leave the slot empty so a future call (after the user
        // points at a llama.cpp ROCm build) can retry.
        let hint = lock_or_poisoned(&state.build_dir_hint).clone();
        let hip_arc: Option<std::sync::Arc<hip::HipRuntime>> = {
            let mut slot = lock_or_poisoned(&state.hip);
            if slot.is_none() {
                let dirs: Vec<std::path::PathBuf> = hint
                    .as_ref()
                    .map(|s| {
                        let p = std::path::PathBuf::from(s);
                        vec![
                            p.clone(),
                            p.join("bin"),
                            p.join("bin/Release"),
                            p.join("Release"),
                        ]
                    })
                    .unwrap_or_default();
                let dir_refs: Vec<&std::path::Path> = dirs.iter().map(|p| p.as_path()).collect();
                if let Some(rt) = hip::HipRuntime::try_open(&dir_refs) {
                    *slot = Some(std::sync::Arc::new(rt));
                }
            }
            slot.clone()
        };

        if let Some(hip) = hip_arc {
            let count = hip.device_count();
            let mut out = Vec::new();
            for i in 0..count {
                if let Some(info) = hip.device_info(i) {
                    let used = info.vram_total.saturating_sub(info.vram_free);
                    out.push(GpuInfo {
                        name: info.name,
                        vram_total_gb: info.vram_total as f64 / 1024.0 / 1024.0 / 1024.0,
                        vram_used_gb: used as f64 / 1024.0 / 1024.0 / 1024.0,
                        // HIP runtime alone can't tell us these. WMI fills
                        // util below; temp/power/clock need ROCm-SMI or ADLX.
                        util: None,
                        temp_c: None,
                        power_w: None,
                        clock_mhz: None,
                    });
                }
            }

            if !out.is_empty() {
                // Layer in WMI engine utilization. We can't reliably map LUID
                // → HIP device index, so we sort the per-adapter maxima
                // descending and assign them to detected GPUs in order. For
                // single-AMD-GPU machines (the common case) this is exact.
                let util_map = gpu_perf::query_util_by_luid();
                let mut have_wmi = false;
                if !util_map.is_empty() {
                    let mut utils: Vec<u32> = util_map.into_values().collect();
                    utils.sort_unstable_by(|a, b| b.cmp(a));
                    for (idx, gpu) in out.iter_mut().enumerate() {
                        if let Some(u) = utils.get(idx) {
                            gpu.util = Some((*u).min(100));
                            have_wmi = true;
                        }
                    }
                }
                let label: &'static str = if have_wmi { "HIP + WMI" } else { "HIP" };
                return (out, label);
            }
        }
    }

    (vec![], "unavailable")
}

// ── Server lifecycle ───────────────────────────────────────────────────────
pub struct ServerState {
    child: Mutex<Option<Child>>,
    info: Mutex<Option<RunningInfo>>,
    // Flips to true once GET /health on the spawned server returns 200.
    ready: Arc<AtomicBool>,
    // Bumped on every start_server / stop_server so an in-flight probe thread
    // for a stale generation exits instead of writing to `ready`.
    probe_gen: Arc<AtomicU64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunningInfo {
    pub pid: u32,
    pub port: u16,
    pub started_at: i64,
    pub binary: String,
}

#[derive(Debug, Serialize)]
pub struct ServerStatus {
    pub running: bool,
    pub ready: bool,
    pub info: Option<RunningInfo>,
}

#[derive(Debug, Clone, Serialize)]
struct ServerLogEvent {
    stream: &'static str,
    pid: u32,
    line: String,
}

// Single-shot probe: TCP connect + raw GET /health, parse the status line.
// Returns true if llama-server replied 200; false for any failure (refused,
// 503 Loading model, read timeout, etc.).
fn probe_health(port: u16) -> bool {
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_millis(500)) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let req = b"GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n";
    if stream.write_all(req).is_err() {
        return false;
    }
    let mut buf = [0u8; 64];
    let n = match stream.read(&mut buf) {
        Ok(n) => n,
        Err(_) => return false,
    };
    let head = &buf[..n];
    head.starts_with(b"HTTP/1.1 200") || head.starts_with(b"HTTP/1.0 200")
}

fn parse_port(args: &[String]) -> u16 {
    let mut iter = args.iter();
    while let Some(a) = iter.next() {
        if a == "--port" {
            if let Some(v) = iter.next() {
                if let Ok(p) = v.parse::<u16>() {
                    return p;
                }
            }
        }
    }
    8080
}

#[tauri::command]
fn start_server(
    app: AppHandle,
    state: State<'_, ServerState>,
    build_dir: String,
    args: Vec<String>,
) -> Result<RunningInfo, String> {
    info!(
        "start_server: build_dir={build_dir} args={}",
        args.join(" ")
    );
    let mut child_slot = lock_or_poisoned(&state.child);
    if let Some(c) = child_slot.as_mut() {
        let info = lock_or_poisoned(&state.info).clone();
        if let Some(info) = info {
            warn!(
                "start_server: already running (pid {}), returning existing info",
                info.pid
            );
            return Ok(info);
        }
        let _ = c.kill();
    }

    let exe_suffix = if cfg!(windows) { ".exe" } else { "" };
    let bin_dir = resolve_bin_dir(&PathBuf::from(&build_dir));
    let server = bin_dir.join(format!("llama-server{}", exe_suffix));
    if !server.is_file() {
        error!(
            "start_server: llama-server not found at {}",
            server.display()
        );
        return Err(format!(
            "llama-server not found at {}",
            server.to_string_lossy()
        ));
    }

    // Validate --model points at an existing file before spawning. Without
    // this, the user sees the server spawn briefly and exit with a generic
    // error in the logs panel.
    let mut model_iter = args.iter();
    while let Some(a) = model_iter.next() {
        if a == "--model" || a == "-m" {
            if let Some(path) = model_iter.next() {
                if !PathBuf::from(path).is_file() {
                    error!("start_server: model file does not exist: {path}");
                    return Err(format!("model file does not exist: {path}"));
                }
            }
            break;
        }
    }

    let port = parse_port(&args);
    let mut child = quiet_command(&server)
        .args(&args)
        .current_dir(&bin_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            error!("start_server: spawn failed: {e}");
            format!("spawn: {e}")
        })?;

    // Take the pipes BEFORE moving `child` into the mutex. We MUST drain both;
    // if we leave them unread, llama-server will eventually block on a write
    // once the OS pipe buffer fills (~64 KB) and effectively freeze.
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();

    let server_info = RunningInfo {
        pid: child.id(),
        port,
        started_at: chrono_now_millis(),
        binary: server.to_string_lossy().into_owned(),
    };
    info!(
        "start_server: spawned pid {} on port {} ({})",
        server_info.pid, server_info.port, server_info.binary,
    );

    *child_slot = Some(child);
    *lock_or_poisoned(&state.info) = Some(server_info.clone());

    // Stream stdout / stderr to the frontend as `server-log` events. Threads
    // exit naturally on EOF, which happens when stop_server kills the child
    // (or the child crashes) and the pipe closes.
    fn spawn_log_pump<R: Read + Send + 'static>(
        app: AppHandle,
        stream: &'static str,
        pid: u32,
        reader: R,
    ) {
        std::thread::spawn(move || {
            let buf = BufReader::new(reader);
            for line in buf.lines() {
                match line {
                    Ok(l) => {
                        let _ = app.emit(
                            "server-log",
                            ServerLogEvent {
                                stream,
                                pid,
                                line: l,
                            },
                        );
                    }
                    Err(_) => break,
                }
            }
            debug!("server-log pump ({stream}, pid {pid}) exited");
        });
    }
    if let Some(out) = stdout_pipe {
        spawn_log_pump(app.clone(), "stdout", server_info.pid, out);
    }
    if let Some(err) = stderr_pipe {
        spawn_log_pump(app.clone(), "stderr", server_info.pid, err);
    }

    // Kick off the readiness probe. Each start gets its own generation; the
    // probe thread bails as soon as the generation changes (i.e. stop_server
    // or a fresh start), so we never write a stale `ready=true`.
    state.ready.store(false, Ordering::SeqCst);
    let gen = state.probe_gen.fetch_add(1, Ordering::SeqCst) + 1;
    let ready = state.ready.clone();
    let probe_gen = state.probe_gen.clone();
    let probe_port = server_info.port;
    std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(600);
        loop {
            if probe_gen.load(Ordering::SeqCst) != gen {
                debug!("health-probe: generation changed, exiting");
                return;
            }
            if std::time::Instant::now() > deadline {
                warn!("health-probe: timed out after 10m without 200 OK");
                return;
            }
            if probe_health(probe_port) {
                if probe_gen.load(Ordering::SeqCst) == gen {
                    ready.store(true, Ordering::SeqCst);
                    info!("health-probe: server ready on port {}", probe_port);
                }
                return;
            }
            std::thread::sleep(Duration::from_millis(300));
        }
    });

    Ok(server_info)
}

#[tauri::command]
fn stop_server(state: State<'_, ServerState>) -> Result<(), String> {
    let mut child_slot = lock_or_poisoned(&state.child);
    let pid = lock_or_poisoned(&state.info).as_ref().map(|i| i.pid);
    if let Some(mut child) = child_slot.take() {
        if let Some(p) = pid {
            info!("stop_server: killing pid {}", p);
        } else {
            info!("stop_server: killing child");
        }
        let _ = child.kill();
        let _ = child.wait();
    } else {
        debug!("stop_server: no child to kill");
    }
    *lock_or_poisoned(&state.info) = None;
    state.ready.store(false, Ordering::SeqCst);
    state.probe_gen.fetch_add(1, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
fn server_status(state: State<'_, ServerState>) -> ServerStatus {
    let mut child_slot = lock_or_poisoned(&state.child);
    let mut info_slot = lock_or_poisoned(&state.info);
    if let Some(child) = child_slot.as_mut() {
        match child.try_wait() {
            Ok(Some(_status)) => {
                // process exited
                *child_slot = None;
                *info_slot = None;
                state.ready.store(false, Ordering::SeqCst);
                state.probe_gen.fetch_add(1, Ordering::SeqCst);
                return ServerStatus {
                    running: false,
                    ready: false,
                    info: None,
                };
            }
            Ok(None) => {}
            Err(_) => {
                *child_slot = None;
                *info_slot = None;
                state.ready.store(false, Ordering::SeqCst);
                state.probe_gen.fetch_add(1, Ordering::SeqCst);
                return ServerStatus {
                    running: false,
                    ready: false,
                    info: None,
                };
            }
        }
    } else {
        return ServerStatus {
            running: false,
            ready: false,
            info: None,
        };
    }
    ServerStatus {
        running: true,
        ready: state.ready.load(Ordering::SeqCst),
        info: info_slot.clone(),
    }
}

fn chrono_now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// Push a directory into recent (de-dup, max 5)
fn push_recent(mut dirs: Vec<String>, dir: &str) -> Vec<String> {
    dirs.retain(|d| d != dir);
    dirs.insert(0, dir.to_string());
    let mut q: VecDeque<String> = dirs.into();
    while q.len() > 5 {
        q.pop_back();
    }
    q.into()
}

// ── Chat sessions ───────────────────────────────────────────────────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    pub time: i64,
    #[serde(default)]
    pub tps: Option<f64>,
    #[serde(default)]
    pub tokens: Option<u32>,
    #[serde(default)]
    pub reasoning: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatSession {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub pinned: bool,
    pub messages: Vec<ChatMessage>,
    /// Per-session overrides (system prompt, MCP toggles, etc.). None means
    /// fall back to the global defaults.
    #[serde(default)]
    pub config: Option<ChatSessionConfig>,
}

fn chats_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    Ok(dir.join("chats.json"))
}

#[tauri::command]
fn load_chats(app: AppHandle) -> Result<Vec<ChatSession>, String> {
    let p = chats_path(&app)?;
    if !p.exists() {
        return Ok(Vec::new());
    }
    let s = fs::read_to_string(&p).map_err(|e| format!("read: {e}"))?;
    let chats: Vec<ChatSession> = serde_json::from_str(&s).map_err(|e| format!("parse: {e}"))?;
    Ok(chats)
}

#[tauri::command]
fn save_chats(app: AppHandle, chats: Vec<ChatSession>) -> Result<(), String> {
    let p = chats_path(&app)?;
    let s = serde_json::to_string(&chats).map_err(|e| format!("encode: {e}"))?;
    fs::write(&p, s).map_err(|e| format!("write: {e}"))
}

#[tauri::command]
fn add_recent_dir(app: AppHandle, hw: State<'_, HwState>, dir: String) -> Result<Settings, String> {
    let mut settings = load_settings(app.clone())?;
    settings.recent_dirs = push_recent(settings.recent_dirs, &dir);
    settings.build_dir = Some(dir.clone());
    save_settings(app, settings.clone())?;
    // Update the HIP search hint and invalidate any prior load so the next
    // hw_snapshot call retries with the new directory.
    *lock_or_poisoned(&hw.build_dir_hint) = Some(dir);
    #[cfg(windows)]
    {
        *lock_or_poisoned(&hw.hip) = None;
    }
    Ok(settings)
}

#[tauri::command]
fn add_recent_models_dir(app: AppHandle, dir: String) -> Result<Settings, String> {
    let mut settings = load_settings(app.clone())?;
    settings.models_recent = push_recent(settings.models_recent, &dir);
    settings.models_dir = Some(dir);
    save_settings(app, settings.clone())?;
    Ok(settings)
}

// ── MCP commands ────────────────────────────────────────────────────────────
#[tauri::command]
fn mcp_connect(
    app: AppHandle,
    reg: State<'_, McpRegistry>,
    id: String,
) -> Result<McpStatus, String> {
    let settings = load_settings(app)?;
    let cfg = settings
        .mcp_servers
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(|| format!("MCP server {id} not found"))?;
    reg.connect(&cfg)
}

#[tauri::command]
fn mcp_disconnect(reg: State<'_, McpRegistry>, id: String) -> Result<(), String> {
    reg.disconnect(&id);
    Ok(())
}

#[tauri::command]
fn mcp_list_tools(reg: State<'_, McpRegistry>, id: String) -> Result<Vec<McpTool>, String> {
    reg.list_tools(&id)
}

#[tauri::command]
fn mcp_call_tool(
    reg: State<'_, McpRegistry>,
    id: String,
    name: String,
    arguments: JsonValue,
) -> Result<JsonValue, String> {
    reg.call_tool(&id, &name, arguments)
}

#[tauri::command]
fn mcp_status_all(app: AppHandle, reg: State<'_, McpRegistry>) -> Result<Vec<McpStatus>, String> {
    let settings = load_settings(app)?;
    Ok(reg.status_all(&settings.mcp_servers))
}

// ── App entry ───────────────────────────────────────────────────────────────
fn init_logging() {
    use std::io::Write;
    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format(|buf, record| {
            let ts = chrono_now_millis();
            writeln!(
                buf,
                "{} [{:<5}] {}: {}",
                ts,
                record.level(),
                record.target(),
                record.args()
            )
        })
        .try_init();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_logging();
    info!("llllllllammmmmmaaaaaaui starting up");
    tauri::Builder::default()
        .setup(|app| {
            // Seed the HIP DLL search hint from persisted settings so AMD
            // detection works on the first hw_snapshot poll.
            if let Ok(s) = load_settings(app.handle().clone()) {
                if let Some(dir) = s.build_dir {
                    if let Some(state) = app.try_state::<HwState>() {
                        *lock_or_poisoned(&state.build_dir_hint) = Some(dir);
                    }
                }
            }
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(ServerState {
            child: Mutex::new(None),
            info: Mutex::new(None),
            ready: Arc::new(AtomicBool::new(false)),
            probe_gen: Arc::new(AtomicU64::new(0)),
        })
        .manage(HwState {
            sys: Mutex::new(System::new_all()),
            #[cfg(feature = "nvml")]
            nvml: std::sync::OnceLock::new(),
            #[cfg(windows)]
            hip: Mutex::new(None),
            build_dir_hint: Mutex::new(None),
        })
        .manage(McpRegistry::default())
        .invoke_handler(tauri::generate_handler![
            load_settings,
            save_settings,
            scan_build,
            scan_models,
            inspect_gguf,
            start_server,
            stop_server,
            server_status,
            add_recent_dir,
            add_recent_models_dir,
            hw_snapshot,
            load_chats,
            save_chats,
            mcp_connect,
            mcp_disconnect,
            mcp_list_tools,
            mcp_call_tool,
            mcp_status_all,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                info!("window destroyed — cleaning up child server");
                if let Some(state) = window.try_state::<ServerState>() {
                    let mut child = lock_or_poisoned(&state.child);
                    if let Some(mut c) = child.take() {
                        let _ = c.kill();
                    }
                }
                if let Some(reg) = window.try_state::<McpRegistry>() {
                    reg.shutdown_all();
                }
            }
        })
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| {
            error!("tauri run failed: {e}");
            std::process::exit(1);
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_port_default_when_missing() {
        assert_eq!(parse_port(&[]), 8080);
        assert_eq!(parse_port(&["--host".into(), "0.0.0.0".into()]), 8080);
    }

    #[test]
    fn parse_port_reads_value() {
        let args = vec!["--port".to_string(), "9090".to_string()];
        assert_eq!(parse_port(&args), 9090);
    }

    #[test]
    fn parse_port_ignores_malformed() {
        let args = vec!["--port".to_string(), "notanumber".to_string()];
        assert_eq!(parse_port(&args), 8080);
    }

    #[test]
    fn parse_bits_quant_tags() {
        assert_eq!(parse_bits("Q4_K_M"), 4);
        assert_eq!(parse_bits("Q8_0"), 8);
        assert_eq!(parse_bits("F16"), 16);
        assert_eq!(parse_bits("BF16"), 16);
        assert_eq!(parse_bits("IQ3_S"), 3);
    }

    #[test]
    fn fmt_size_units() {
        assert_eq!(fmt_size(512), "512 B");
        assert_eq!(fmt_size(2 * 1024), "2 KB");
        assert_eq!(fmt_size(3 * 1024 * 1024), "3 MB");
        assert!(fmt_size(2 * 1024 * 1024 * 1024).starts_with("2.0 GB"));
    }

    #[test]
    fn push_recent_dedupes_and_caps_at_five() {
        let mut v: Vec<String> = vec![];
        for name in ["a", "b", "c", "d", "e", "f"] {
            v = push_recent(v, name);
        }
        assert_eq!(v.len(), 5);
        // Most recent first
        assert_eq!(v[0], "f");
        // Pushing an existing entry moves it to the front
        v = push_recent(v, "c");
        assert_eq!(v[0], "c");
        assert_eq!(v.len(), 5);
    }

    #[test]
    fn extract_quant_tag_strips_model_prefix() {
        assert_eq!(
            extract_quant_tag("Qwen-7B-Q4_K_M.gguf", "Qwen-7B"),
            "Q4_K_M"
        );
        // No prefix match → last dash-separated chunk
        assert_eq!(extract_quant_tag("model-x-Q8_0.gguf", "other"), "Q8_0");
    }

    #[test]
    fn is_mmproj_filename_matches_variants() {
        assert!(is_mmproj_filename("mmproj-vision.gguf"));
        assert!(is_mmproj_filename("mm-proj-foo.gguf"));
        assert!(is_mmproj_filename("MMPROJ-uppercase.gguf"));
        assert!(!is_mmproj_filename("model-mtp.gguf"));
    }

    #[test]
    fn canonical_dir_rejects_nonexistent() {
        let err = canonical_dir("Z:/definitely-does-not-exist-lllammmui-test");
        assert!(err.is_err());
    }

    #[test]
    fn canonical_dir_accepts_existing_dir() {
        let tmp = std::env::temp_dir();
        let s = tmp.to_string_lossy().into_owned();
        let canonical = canonical_dir(&s).expect("temp dir should be canonicalizable");
        assert!(canonical.is_dir());
    }

    #[test]
    fn settings_roundtrip_preserves_known_fields() {
        let s = Settings {
            build_dir: Some("/tmp/builds".into()),
            recent_dirs: vec!["/a".into(), "/b".into()],
            model_path: Some("/tmp/model.gguf".into()),
            flags: serde_json::json!({ "ngl": 99, "fa": true }),
            models_dir: None,
            models_recent: vec![],
            profiles: vec![],
            reasoning_enabled: Some(false),
            mcp_servers: vec![],
            chat_presets: vec![],
        };
        let encoded = serde_json::to_string(&s).unwrap();
        let decoded: Settings = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded.build_dir.as_deref(), Some("/tmp/builds"));
        assert_eq!(decoded.recent_dirs, vec!["/a", "/b"]);
        assert_eq!(decoded.reasoning_enabled, Some(false));
        assert_eq!(decoded.flags["ngl"], 99);
    }

    #[test]
    fn settings_decodes_missing_fields_as_defaults() {
        let minimal = r#"{}"#;
        let decoded: Settings = serde_json::from_str(minimal).unwrap();
        assert!(decoded.recent_dirs.is_empty());
        assert!(decoded.profiles.is_empty());
        assert_eq!(decoded.reasoning_enabled, None);
    }

    #[test]
    fn lock_or_poisoned_recovers_from_panic() {
        use std::sync::Arc;
        use std::sync::Mutex;
        use std::thread;

        let m = Arc::new(Mutex::new(42_u32));
        let m2 = m.clone();
        let _ = thread::spawn(move || {
            let _guard = m2.lock().unwrap();
            panic!("poison the mutex");
        })
        .join();
        // After the panic the mutex is poisoned but our helper recovers it.
        let guard = lock_or_poisoned(&m);
        assert_eq!(*guard, 42);
    }
}
