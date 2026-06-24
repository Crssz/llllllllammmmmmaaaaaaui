//! In-app llama.cpp engine manager: browse official `ggml-org/llama.cpp` GitHub
//! releases, download + extract a chosen Windows build into a managed library
//! under the app data dir, and keep several versions side by side.
//!
//! The *active* engine is still just `settings.build_dir`, so the rest of the
//! app (server, bench, hw) is untouched — "activate" on the frontend is the
//! existing `add_recent_dir`/`setBuildDir`. Downloads run on a detached worker
//! thread (sync commands block the STA main thread) and stream progress via
//! `engine-progress` / `engine-done` events, mirroring `bench.rs`. A `busy`
//! flag enforces one in-flight download; a `cancel` flag + generation counter
//! let a cancelled/superseded run bail without leaving the UI stuck.
//!
//! Storage layout under `app_data_dir/engines/`:
//! ```text
//! .tmp/<id>.part            in-progress download (removed on done/cancel)
//! <id>/                     extracted release, id = "<tag>-<variant>-<arch>"
//!   llama-server.exe, *.dll
//!   engine.json             our manifest (version/commit/backends/installed_at)
//! ```

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use log::{debug, info, warn};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::build_scan::{fmt_size, scan_build};
use crate::settings::load_settings;
use crate::util::{canonical_dir, chrono_now_millis};

const RELEASES_URL: &str = "https://api.github.com/repos/ggml-org/llama.cpp/releases";
/// GitHub rejects API requests without a User-Agent.
const USER_AGENT: &str = "llllllllammmmmmaaaaaaui";
const DEFAULT_LIMIT: u32 = 20;
const MANIFEST_FILE: &str = "engine.json";
/// Emit a download-progress event at most once per this many bytes so a
/// ~200 MB zip doesn't spam thousands of events at the UI.
const PROGRESS_STEP: u64 = 1024 * 1024;
/// Hard ceiling on total extracted bytes — defense-in-depth against a corrupt
/// or malicious archive (a decompression bomb). Real llama.cpp Windows builds
/// are well under 1 GB.
const MAX_EXTRACTED_BYTES: u64 = 8 * 1024 * 1024 * 1024;

// ── Managed state ────────────────────────────────────────────────────────────

/// State for the (single) in-flight engine download. Fields are `Arc` so the
/// command thread can hand clones to the detached worker.
pub struct EngineState {
    /// True while a download worker is alive; a second `download_engine` while
    /// this is set is rejected.
    pub busy: Arc<AtomicBool>,
    /// Set by `cancel_engine_download`; read by the worker between chunks.
    pub cancel: Arc<AtomicBool>,
    /// Bumped on every download start. Stamped on events so the frontend can
    /// drop a superseded run's late events.
    pub generation: Arc<AtomicU64>,
}

impl Default for EngineState {
    fn default() -> Self {
        Self {
            busy: Arc::new(AtomicBool::new(false)),
            cancel: Arc::new(AtomicBool::new(false)),
            generation: Arc::new(AtomicU64::new(0)),
        }
    }
}

// ── Wire types ───────────────────────────────────────────────────────────────

/// One downloadable Windows asset of a release.
#[derive(Debug, Clone, Serialize)]
pub struct EngineAsset {
    pub name: String,
    pub url: String,
    pub size: u64,
    /// Accelerator flavour: "vulkan" | "cpu" | "cuda" | "hip" | "hip-gfxNNNN" | "other".
    pub variant: String,
    pub os: String,
    pub arch: String,
    /// Stable install id this asset extracts to: "<tag>-<variant>-<arch>".
    pub id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct EngineRelease {
    pub tag: String,
    pub name: String,
    pub published_at: String,
    pub assets: Vec<EngineAsset>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledEngine {
    pub id: String,
    pub path: String,
    pub tag: Option<String>,
    pub variant: Option<String>,
    pub arch: Option<String>,
    pub version: Option<String>,
    pub commit: Option<String>,
    #[serde(default)]
    pub backend_badges: Vec<String>,
    pub size: String,
    pub installed_at: Option<i64>,
    pub active: bool,
}

/// GitHub releases API shapes — only the subset we use.
#[derive(Debug, Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

#[derive(Debug, Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    size: u64,
}

/// Persisted `engine.json` so listing installed engines is pure filesystem
/// (no per-dir `llama-server --version` spawn).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct EngineManifest {
    id: String,
    tag: Option<String>,
    variant: Option<String>,
    arch: Option<String>,
    version: Option<String>,
    commit: Option<String>,
    #[serde(default)]
    backend_badges: Vec<String>,
    installed_at: i64,
    #[serde(default)]
    asset: Option<String>,
}

#[derive(Clone, Serialize)]
struct EngineProgress {
    generation: u64,
    id: String,
    tag: String,
    /// "download" | "extract" | "scan".
    phase: String,
    downloaded: u64,
    total: u64,
}

#[derive(Clone, Serialize)]
struct EngineDone {
    generation: u64,
    id: String,
    tag: String,
    ok: bool,
    cancelled: bool,
    error: Option<String>,
    installed: Option<InstalledEngine>,
}

// ── Asset classification ─────────────────────────────────────────────────────

/// Only consider Windows binary release zips produced by llama.cpp (drops the
/// `cudart-*` runtime, Linux/macOS assets, and `.tar.gz`).
fn is_engine_asset(name: &str) -> bool {
    let n = name.to_lowercase();
    n.starts_with("llama-") && n.contains("bin-win") && n.ends_with(".zip")
}

/// Pull (os, arch, variant) out of an asset filename.
fn classify_asset(name: &str) -> (String, String, String) {
    let n = name.to_lowercase();
    let os = "win".to_string();
    let arch = if n.contains("arm64") { "arm64" } else { "x64" }.to_string();
    let variant = if n.contains("vulkan") {
        "vulkan".to_string()
    } else if n.contains("cuda") {
        "cuda".to_string()
    } else if n.contains("hip") || n.contains("rocm") {
        match extract_gfx(&n) {
            Some(g) => format!("hip-{g}"),
            None => "hip".to_string(),
        }
    } else if n.contains("cpu") {
        "cpu".to_string()
    } else if arch == "arm64" {
        // arm64 builds with no explicit accelerator are CPU.
        "cpu".to_string()
    } else {
        "other".to_string()
    };
    (os, arch, variant)
}

/// Extract a `gfxNNNN` token (e.g. "gfx1100") from a lowercased asset name.
fn extract_gfx(lower_name: &str) -> Option<String> {
    let idx = lower_name.find("gfx")?;
    let token: String = lower_name[idx..]
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric())
        .collect();
    if token.len() > 3 && token[3..].chars().any(|c| c.is_ascii_digit()) {
        Some(token)
    } else {
        None
    }
}

fn engine_id(tag: &str, variant: &str, arch: &str) -> String {
    format!("{tag}-{variant}-{arch}")
}

/// Best-effort reverse of `engine_id`. `tag` has no '-', `arch` is the final
/// segment, and `variant` is everything between (may itself contain '-', e.g.
/// "hip-gfx1100"). Manifests are the primary source; this is the fallback for
/// dirs with no `engine.json`.
fn parse_id(id: &str) -> (Option<String>, Option<String>, Option<String>) {
    let (tag, rest) = match id.split_once('-') {
        Some(t) => t,
        None => return (None, None, None),
    };
    match rest.rsplit_once('-') {
        Some((variant, arch)) => (
            Some(tag.to_string()),
            Some(variant.to_string()),
            Some(arch.to_string()),
        ),
        None => (Some(tag.to_string()), Some(rest.to_string()), None),
    }
}

// ── Filesystem helpers ───────────────────────────────────────────────────────

fn engines_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("engines");
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir engines: {e}"))?;
    Ok(dir)
}

fn dir_size(path: &Path) -> u64 {
    let mut total = 0;
    if let Ok(rd) = fs::read_dir(path) {
        for entry in rd.flatten() {
            match entry.metadata() {
                Ok(m) if m.is_dir() => total += dir_size(&entry.path()),
                Ok(m) => total += m.len(),
                Err(_) => {}
            }
        }
    }
    total
}

fn read_manifest(dir: &Path) -> Option<EngineManifest> {
    let s = fs::read_to_string(dir.join(MANIFEST_FILE)).ok()?;
    serde_json::from_str(&s).ok()
}

fn write_manifest(dir: &Path, m: &EngineManifest) -> Result<(), String> {
    let s = serde_json::to_string_pretty(m).map_err(|e| format!("encode manifest: {e}"))?;
    fs::write(dir.join(MANIFEST_FILE), s).map_err(|e| format!("write manifest: {e}"))
}

/// Canonical form for active-engine comparison, matching how `scan_build`
/// canonicalizes (`util::canonical_dir`).
fn canon(p: &str) -> Option<PathBuf> {
    canonical_dir(p).ok()
}

// ── Commands ─────────────────────────────────────────────────────────────────

/// Fetch the latest llama.cpp releases and their Windows engine assets. Network
/// I/O, so it runs off the main (STA) thread via `spawn_blocking`.
#[tauri::command]
pub async fn list_engine_releases(limit: Option<u32>) -> Result<Vec<EngineRelease>, String> {
    tauri::async_runtime::spawn_blocking(move || fetch_releases(limit.unwrap_or(DEFAULT_LIMIT)))
        .await
        .map_err(|e| format!("list_engine_releases task failed: {e}"))?
}

fn fetch_releases(limit: u32) -> Result<Vec<EngineRelease>, String> {
    let url = format!("{RELEASES_URL}?per_page={limit}");
    info!("engines: fetching releases {url}");
    let resp = ureq::get(&url)
        .set("User-Agent", USER_AGENT)
        .set("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(30))
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(403, _) => {
                "GitHub API rate limit reached (60 requests/hour for unauthenticated access). Try again later.".to_string()
            }
            other => format!("fetch releases: {other}"),
        })?;
    let gh: Vec<GhRelease> = resp
        .into_json()
        .map_err(|e| format!("parse releases JSON: {e}"))?;

    let releases = gh
        .into_iter()
        .map(|r| {
            let tag = r.tag_name;
            let mut assets: Vec<EngineAsset> = r
                .assets
                .into_iter()
                .filter(|a| is_engine_asset(&a.name))
                .map(|a| {
                    let (os, arch, variant) = classify_asset(&a.name);
                    let id = engine_id(&tag, &variant, &arch);
                    EngineAsset {
                        name: a.name,
                        url: a.browser_download_url,
                        size: a.size,
                        variant,
                        os,
                        arch,
                        id,
                    }
                })
                .collect();
            assets.sort_by(|a, b| a.variant.cmp(&b.variant).then(a.arch.cmp(&b.arch)));
            EngineRelease {
                name: r.name.unwrap_or_else(|| tag.clone()),
                published_at: r.published_at.unwrap_or_default(),
                tag,
                assets,
            }
        })
        // Drop releases with no Windows engine assets at all.
        .filter(|r| !r.assets.is_empty())
        .collect();
    Ok(releases)
}

/// List engines already downloaded into the library, newest install first.
#[tauri::command]
pub fn list_installed_engines(app: AppHandle) -> Result<Vec<InstalledEngine>, String> {
    let dir = engines_dir(&app)?;
    let active = load_settings(app.clone())
        .ok()
        .and_then(|s| s.build_dir)
        .and_then(|p| canon(&p));

    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| format!("read engines dir: {e}"))? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().into_owned();
        if id == ".tmp" {
            continue;
        }
        out.push(read_installed(&path, &id, active.as_deref()));
    }
    // Newest install first; dirs without a manifest (installed_at None) sink.
    out.sort_by(|a, b| b.installed_at.cmp(&a.installed_at).then(b.id.cmp(&a.id)));
    Ok(out)
}

fn read_installed(path: &Path, id: &str, active: Option<&Path>) -> InstalledEngine {
    let path_str = path.to_string_lossy().into_owned();
    let active_match = match (active, canon(&path_str)) {
        (Some(a), Some(c)) => a == c.as_path(),
        _ => false,
    };
    let size = fmt_size(dir_size(path));

    if let Some(m) = read_manifest(path) {
        return InstalledEngine {
            id: id.to_string(),
            path: path_str,
            tag: m.tag,
            variant: m.variant,
            arch: m.arch,
            version: m.version,
            commit: m.commit,
            backend_badges: m.backend_badges,
            size,
            installed_at: Some(m.installed_at),
            active: active_match,
        };
    }

    // No manifest (e.g. a manually-dropped dir): fall back to a live scan.
    let info = scan_build(path_str.clone()).ok();
    let (tag, variant, arch) = parse_id(id);
    InstalledEngine {
        id: id.to_string(),
        path: path_str,
        tag,
        variant,
        arch,
        version: info.as_ref().and_then(|i| i.version.clone()),
        commit: info.as_ref().and_then(|i| i.commit.clone()),
        backend_badges: info.map(|i| i.backend_badges).unwrap_or_default(),
        size,
        installed_at: None,
        active: active_match,
    }
}

/// Start downloading + extracting an engine asset. Returns immediately with the
/// run's generation id; progress arrives via `engine-progress` and the terminal
/// result via a single `engine-done` event.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn download_engine(
    app: AppHandle,
    state: State<'_, EngineState>,
    tag: String,
    variant: String,
    arch: String,
    asset_name: String,
    asset_url: String,
    expected_size: Option<u64>,
) -> Result<u64, String> {
    if state
        .busy
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("a download is already running".into());
    }
    state.cancel.store(false, Ordering::SeqCst);
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;

    let id = engine_id(&tag, &variant, &arch);
    let engines = match engines_dir(&app) {
        Ok(d) => d,
        Err(e) => {
            state.busy.store(false, Ordering::SeqCst);
            return Err(e);
        }
    };
    info!("engines: download gen {generation} id={id} url={asset_url}");

    let busy = state.busy.clone();
    let cancel = state.cancel.clone();
    let gen_arc = state.generation.clone();
    let total_hint = expected_size.unwrap_or(0);

    std::thread::spawn(move || {
        // Catch any panic in the worker body so the `busy` slot is ALWAYS
        // released and a terminal `engine-done` is ALWAYS emitted. Otherwise a
        // panic (e.g. deep inside the zip crate) would latch busy=true forever —
        // bricking all future downloads — and leave the UI stuck on
        // "downloading" with no way to recover (cancel only sets a flag the dead
        // worker would never read).
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run_download(
                &app,
                &engines,
                &id,
                &tag,
                &asset_name,
                &asset_url,
                total_hint,
                generation,
                &gen_arc,
                &cancel,
            )
        }))
        .unwrap_or_else(|_| Err("download worker panicked".to_string()));
        let cancelled = cancel.load(Ordering::SeqCst);
        // Reclaim the partial download on any failure (including a panic);
        // success and cancel already remove it inside run_download.
        if result.is_err() {
            let _ = fs::remove_file(engines.join(".tmp").join(format!("{id}.part")));
        }
        // Release the slot before emitting so the UI can immediately retry.
        busy.store(false, Ordering::SeqCst);

        let done = match result {
            Ok(installed) => EngineDone {
                generation,
                id: id.clone(),
                tag: tag.clone(),
                ok: true,
                cancelled: false,
                error: None,
                installed: Some(installed),
            },
            Err(e) if cancelled => {
                debug!("engines: download gen {generation} cancelled ({e})");
                EngineDone {
                    generation,
                    id: id.clone(),
                    tag: tag.clone(),
                    ok: false,
                    cancelled: true,
                    error: None,
                    installed: None,
                }
            }
            Err(e) => {
                warn!("engines: download gen {generation} failed: {e}");
                EngineDone {
                    generation,
                    id: id.clone(),
                    tag: tag.clone(),
                    ok: false,
                    cancelled: false,
                    error: Some(e),
                    installed: None,
                }
            }
        };
        let _ = app.emit("engine-done", done);
    });

    Ok(generation)
}

#[allow(clippy::too_many_arguments)]
fn run_download(
    app: &AppHandle,
    engines: &Path,
    id: &str,
    tag: &str,
    asset_name: &str,
    asset_url: &str,
    total_hint: u64,
    generation: u64,
    gen_arc: &AtomicU64,
    cancel: &AtomicBool,
) -> Result<InstalledEngine, String> {
    let tmp_dir = engines.join(".tmp");
    fs::create_dir_all(&tmp_dir).map_err(|e| format!("mkdir tmp: {e}"))?;
    let part = tmp_dir.join(format!("{id}.part"));
    let target = engines.join(id);
    // Fresh start — clear any stale partial / previous install of the same id.
    let _ = fs::remove_file(&part);
    let _ = fs::remove_dir_all(&target);

    let emit = |phase: &str, downloaded: u64, total: u64| {
        let _ = app.emit(
            "engine-progress",
            EngineProgress {
                generation,
                id: id.to_string(),
                tag: tag.to_string(),
                phase: phase.to_string(),
                downloaded,
                total,
            },
        );
    };
    let aborted = || cancel.load(Ordering::SeqCst) || gen_arc.load(Ordering::SeqCst) != generation;

    // ── Download (streamed to disk) ──────────────────────────────────────
    // Per-operation timeouts (connect + idle read), NOT an overall deadline: a
    // large engine zip can take minutes on a slow link, and an overall
    // `.timeout` would abort an otherwise healthy long download. ureq can't be
    // aborted mid-connect by our flag, so we keep connect short and re-check
    // `aborted()` the instant headers arrive.
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(20))
        .timeout_read(Duration::from_secs(60))
        .build();
    let resp = agent
        .get(asset_url)
        .set("User-Agent", USER_AGENT)
        .call()
        .map_err(|e| format!("download request: {e}"))?;
    if aborted() {
        return Err("cancelled".into());
    }
    let total = resp
        .header("Content-Length")
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(total_hint);

    {
        let mut reader = resp.into_reader();
        let mut file = fs::File::create(&part).map_err(|e| format!("create part file: {e}"))?;
        let mut buf = vec![0u8; 64 * 1024];
        let mut downloaded: u64 = 0;
        let mut last_emit: u64 = 0;
        loop {
            if aborted() {
                let _ = fs::remove_file(&part);
                return Err("cancelled".into());
            }
            let n = reader
                .read(&mut buf)
                .map_err(|e| format!("read body: {e}"))?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n])
                .map_err(|e| format!("write part: {e}"))?;
            downloaded += n as u64;
            if downloaded - last_emit >= PROGRESS_STEP {
                last_emit = downloaded;
                emit("download", downloaded, total);
            }
        }
        file.flush().map_err(|e| format!("flush part: {e}"))?;
        emit("download", downloaded, total);
    }

    // ── Extract ──────────────────────────────────────────────────────────
    emit("extract", total, total);
    extract_zip(&part, &target, cancel)?;
    let _ = fs::remove_file(&part);

    // ── Scan + write manifest ────────────────────────────────────────────
    emit("scan", total, total);
    let info = scan_build(target.to_string_lossy().into_owned()).ok();
    let (ptag, pvariant, parch) = parse_id(id);
    let manifest = EngineManifest {
        id: id.to_string(),
        tag: ptag.clone(),
        variant: pvariant.clone(),
        arch: parch.clone(),
        version: info.as_ref().and_then(|i| i.version.clone()),
        commit: info.as_ref().and_then(|i| i.commit.clone()),
        backend_badges: info
            .as_ref()
            .map(|i| i.backend_badges.clone())
            .unwrap_or_default(),
        installed_at: chrono_now_millis(),
        asset: Some(asset_name.to_string()),
    };
    write_manifest(&target, &manifest)?;
    info!("engines: installed {id} ({:?})", manifest.version);

    Ok(InstalledEngine {
        id: id.to_string(),
        path: target.to_string_lossy().into_owned(),
        tag: ptag,
        variant: pvariant,
        arch: parch,
        version: manifest.version,
        commit: manifest.commit,
        backend_badges: manifest.backend_badges,
        size: fmt_size(dir_size(&target)),
        installed_at: Some(manifest.installed_at),
        active: false,
    })
}

/// Extract `zip_path` into `target`, guarding against zip-slip via
/// `ZipFile::enclosed_name` (rejects absolute paths and `..` escapes).
fn extract_zip(zip_path: &Path, target: &Path, cancel: &AtomicBool) -> Result<(), String> {
    let file = fs::File::open(zip_path).map_err(|e| format!("open zip: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("read zip: {e}"))?;
    fs::create_dir_all(target).map_err(|e| format!("mkdir target: {e}"))?;
    let mut extracted: u64 = 0;
    for i in 0..archive.len() {
        if cancel.load(Ordering::SeqCst) {
            let _ = fs::remove_dir_all(target);
            return Err("cancelled".into());
        }
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("zip entry {i}: {e}"))?;
        let rel = match entry.enclosed_name() {
            Some(p) => p,
            None => {
                warn!("engines: skipping unsafe zip entry {}", entry.name());
                continue;
            }
        };
        let out_path = target.join(&rel);
        if entry.is_dir() {
            fs::create_dir_all(&out_path)
                .map_err(|e| format!("mkdir {}: {e}", out_path.display()))?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
            }
            let mut out = fs::File::create(&out_path)
                .map_err(|e| format!("create {}: {e}", out_path.display()))?;
            let written = std::io::copy(&mut entry, &mut out)
                .map_err(|e| format!("extract {}: {e}", out_path.display()))?;
            extracted = extracted.saturating_add(written);
            if extracted > MAX_EXTRACTED_BYTES {
                let _ = fs::remove_dir_all(target);
                return Err("archive exceeds the maximum extracted size".into());
            }
        }
    }
    Ok(())
}

/// Signal the in-flight download to stop. The worker cleans up the partial and
/// emits the terminal `engine-done` (so it remains the sole emitter).
#[tauri::command]
pub fn cancel_engine_download(state: State<'_, EngineState>) -> Result<(), String> {
    state.cancel.store(true, Ordering::SeqCst);
    Ok(())
}

/// Remove a downloaded engine from the library. Refuses the active engine.
#[tauri::command]
pub fn delete_engine(app: AppHandle, id: String) -> Result<(), String> {
    if id.is_empty() || id == ".tmp" || id.contains("..") || id.contains('/') || id.contains('\\') {
        return Err("invalid engine id".into());
    }
    let target = engines_dir(&app)?.join(&id);
    if !target.is_dir() {
        return Err(format!("engine {id} not found"));
    }
    let active = load_settings(app.clone())
        .ok()
        .and_then(|s| s.build_dir)
        .and_then(|p| canon(&p));
    if let (Some(a), Some(c)) = (active, canon(&target.to_string_lossy())) {
        if a == c {
            return Err("that engine is active — switch to another engine first".into());
        }
    }
    fs::remove_dir_all(&target).map_err(|e| format!("delete engine: {e}"))?;
    info!("engines: deleted {id}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_vulkan_x64() {
        let (os, arch, variant) = classify_asset("llama-b6841-bin-win-vulkan-x64.zip");
        assert_eq!(os, "win");
        assert_eq!(arch, "x64");
        assert_eq!(variant, "vulkan");
    }

    #[test]
    fn classify_hip_keeps_gfx_target() {
        let (_, arch, variant) = classify_asset("llama-b6841-bin-win-hip-x64-gfx1100.zip");
        assert_eq!(arch, "x64");
        assert_eq!(variant, "hip-gfx1100");
    }

    #[test]
    fn classify_cuda_cpu_and_arm() {
        assert_eq!(
            classify_asset("llama-b1-bin-win-cuda-12.4-x64.zip").2,
            "cuda"
        );
        assert_eq!(classify_asset("llama-b1-bin-win-cpu-x64.zip").2, "cpu");
        let (_, arch, variant) = classify_asset("llama-b1-bin-win-arm64.zip");
        assert_eq!(arch, "arm64");
        assert_eq!(variant, "cpu");
    }

    #[test]
    fn is_engine_asset_filters_noise() {
        assert!(is_engine_asset("llama-b6841-bin-win-vulkan-x64.zip"));
        // CUDA runtime, not an engine build.
        assert!(!is_engine_asset("cudart-llama-bin-win-cuda-12.4-x64.zip"));
        assert!(!is_engine_asset("llama-b6841-bin-ubuntu-x64.zip"));
        assert!(!is_engine_asset("llama-b6841-bin-macos-arm64.zip"));
        assert!(!is_engine_asset("llama-b6841-bin-win-vulkan-x64.tar.gz"));
    }

    #[test]
    fn engine_id_and_parse_roundtrip() {
        assert_eq!(engine_id("b6841", "vulkan", "x64"), "b6841-vulkan-x64");
        let (t, v, a) = parse_id("b6841-vulkan-x64");
        assert_eq!(t.as_deref(), Some("b6841"));
        assert_eq!(v.as_deref(), Some("vulkan"));
        assert_eq!(a.as_deref(), Some("x64"));
    }

    #[test]
    fn parse_id_handles_dashed_variant() {
        let (t, v, a) = parse_id("b6841-hip-gfx1100-x64");
        assert_eq!(t.as_deref(), Some("b6841"));
        assert_eq!(v.as_deref(), Some("hip-gfx1100"));
        assert_eq!(a.as_deref(), Some("x64"));
    }

    #[test]
    fn extract_gfx_token() {
        assert_eq!(
            extract_gfx("llama-b1-bin-win-hip-x64-gfx1100.zip").as_deref(),
            Some("gfx1100")
        );
        assert_eq!(extract_gfx("llama-b1-bin-win-vulkan-x64.zip"), None);
    }

    #[test]
    fn extract_zip_rejects_zip_slip_entry() {
        // Build an in-memory zip containing a `..` escape and a normal file,
        // then extract and confirm only the safe file lands inside `target`.
        let mut bytes = Vec::new();
        {
            let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut bytes));
            let opts: zip::write::SimpleFileOptions = Default::default();
            w.start_file("../escape.txt", opts).unwrap();
            w.write_all(b"pwned").unwrap();
            w.start_file("llama-server.txt", opts).unwrap();
            w.write_all(b"ok").unwrap();
            w.finish().unwrap();
        }
        let tmp = std::env::temp_dir().join(format!("lmst-zip-slip-{}", chrono_now_millis()));
        let zip_path = tmp.join("a.zip");
        fs::create_dir_all(&tmp).unwrap();
        fs::write(&zip_path, &bytes).unwrap();

        let target = tmp.join("out");
        extract_zip(&zip_path, &target, &AtomicBool::new(false)).unwrap();

        assert!(target.join("llama-server.txt").is_file());
        // The escape must NOT have been written to the parent of `target`.
        assert!(!tmp.join("escape.txt").exists());

        let _ = fs::remove_dir_all(&tmp);
    }
}
