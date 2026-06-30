//! In-app HuggingFace GGUF model catalog: search the Hub for GGUF models,
//! list a repo's quant files (sizes pulled from the tree API), and download a
//! chosen quant into the user's models directory so it shows up in the Models
//! library on the next scan.
//!
//! Download mechanics mirror `engines.rs`: a detached worker thread (sync
//! commands block the STA main thread) streams progress via `catalog-progress`
//! / `catalog-done` events, a `busy` flag enforces one in-flight download, and
//! a `cancel` flag + generation counter let a cancelled/superseded run bail.
//!
//! Files land at `<models_root>/<owner>/<repo>/<file>.gguf`, matching the
//! `<owner>/<model>/*.gguf` layout `models_scan.rs` expects. Large quants split
//! across `-00001-of-000NN.gguf` parts are grouped into one logical entry and
//! all parts are downloaded together (llama.cpp auto-loads sibling shards).
//! `<models_root>` is the user's `models_dir` when set, else `app_data/models`.

use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use log::{debug, info, warn};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::models_scan::{
    detect_badges, extract_quant_tag, guess_params, is_mmproj_filename, parse_bits,
};

const SEARCH_URL: &str = "https://huggingface.co/api/models";
const USER_AGENT: &str = "llllllllammmmmmaaaaaaui";
const DEFAULT_LIMIT: u32 = 30;
const MAX_LIMIT: u32 = 100;
/// Emit a download-progress event at most once per this many bytes so a
/// multi-GB model doesn't spam thousands of events at the UI.
const PROGRESS_STEP: u64 = 2 * 1024 * 1024;

// ── Managed state ────────────────────────────────────────────────────────────

/// State for the (single) in-flight model download. Fields are `Arc` so the
/// command thread can hand clones to the detached worker.
pub struct CatalogState {
    /// True while a download worker is alive; a second download while this is
    /// set is rejected.
    pub busy: Arc<AtomicBool>,
    /// Set by `cancel_catalog_download`; read by the worker between chunks.
    pub cancel: Arc<AtomicBool>,
    /// Bumped on every download start. Stamped on events so the frontend can
    /// drop a superseded run's late events.
    pub generation: Arc<AtomicU64>,
}

impl Default for CatalogState {
    fn default() -> Self {
        Self {
            busy: Arc::new(AtomicBool::new(false)),
            cancel: Arc::new(AtomicBool::new(false)),
            generation: Arc::new(AtomicU64::new(0)),
        }
    }
}

// ── Wire types ───────────────────────────────────────────────────────────────

/// One model in the catalog search results.
#[derive(Debug, Clone, Serialize)]
pub struct CatalogModel {
    /// Full repo id, "owner/name".
    pub id: String,
    pub owner: String,
    pub name: String,
    pub downloads: u64,
    pub likes: u64,
    /// True when the repo requires accepting terms / a token to download.
    pub gated: bool,
    /// "auto" | "manual" when gated, else None.
    pub gated_kind: Option<String>,
    pub pipeline_tag: Option<String>,
    pub library_name: Option<String>,
    pub last_modified: Option<String>,
    pub tags: Vec<String>,
    /// Number of *.gguf siblings (quick indicator before the tree is fetched).
    pub gguf_count: usize,
    /// Parameter size guessed from the repo name (e.g. "7B"), when present.
    pub params: Option<String>,
}

/// One downloadable quant in a repo (a single file, or a group of split parts).
#[derive(Debug, Clone, Serialize)]
pub struct CatalogFile {
    /// Representative local filename (the first part for split models).
    pub filename: String,
    /// Quant tag, e.g. "Q4_K_M".
    pub tag: String,
    pub bits: u8,
    /// Total size in bytes across all parts.
    pub size: u64,
    pub size_gb: f64,
    pub badges: Vec<String>,
    /// True when this quant is split across multiple shard files.
    pub is_split: bool,
    pub n_parts: usize,
    /// Repo-relative paths of every part, ordered, for the resolve URL.
    pub url_paths: Vec<String>,
    /// True for multimodal projector files (mmproj-*.gguf).
    pub is_mmproj: bool,
}

#[derive(Clone, Serialize)]
struct CatalogProgress {
    generation: u64,
    repo_id: String,
    filename: String,
    downloaded: u64,
    total: u64,
    /// 1-based index of the part currently downloading.
    part: usize,
    parts: usize,
}

#[derive(Clone, Serialize)]
struct CatalogDone {
    generation: u64,
    repo_id: String,
    filename: String,
    ok: bool,
    cancelled: bool,
    error: Option<String>,
    /// Models root the file landed under (so the UI can adopt it as models_dir).
    dest_root: Option<String>,
    /// Absolute path of the (first) downloaded file.
    model_path: Option<String>,
}

// ── HuggingFace API shapes (only the subset we use) ─────────────────────────

#[derive(Debug, Deserialize)]
struct HfModel {
    id: String,
    #[serde(default)]
    author: Option<String>,
    #[serde(default)]
    downloads: u64,
    #[serde(default)]
    likes: u64,
    /// `false` or a string ("auto" | "manual").
    #[serde(default)]
    gated: JsonValue,
    #[serde(default)]
    pipeline_tag: Option<String>,
    #[serde(default)]
    library_name: Option<String>,
    #[serde(default, rename = "lastModified")]
    last_modified: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    siblings: Vec<HfSibling>,
}

#[derive(Debug, Deserialize)]
struct HfSibling {
    #[serde(default)]
    rfilename: String,
}

#[derive(Debug, Deserialize)]
struct HfTreeEntry {
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    lfs: Option<HfLfs>,
}

#[derive(Debug, Deserialize)]
struct HfLfs {
    #[serde(default)]
    size: u64,
}

// ── Validation helpers (path-safety for filenames and repo ids) ─────────────

/// A single path segment that is safe to use as a filename and as a URL path
/// component: non-empty, not "."/"..", and only HF's allowed name characters.
fn is_safe_segment(s: &str) -> bool {
    !s.is_empty()
        && s != "."
        && s != ".."
        && !s.contains("..")
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// "owner/name" with exactly one slash and two safe segments.
fn valid_repo_id(s: &str) -> bool {
    let mut it = s.split('/');
    match (it.next(), it.next(), it.next()) {
        (Some(a), Some(b), None) => is_safe_segment(a) && is_safe_segment(b),
        _ => false,
    }
}

/// A repo-relative file path: one or more safe segments joined by '/', ending
/// in `.gguf`. Accepts files in subfolders (some repos shard into per-quant
/// dirs) but rejects any traversal.
fn valid_gguf_path(s: &str) -> bool {
    if !s.to_lowercase().ends_with(".gguf") {
        return false;
    }
    let segs: Vec<&str> = s.split('/').collect();
    !segs.is_empty() && segs.iter().all(|seg| is_safe_segment(seg))
}

/// Local filename for a repo-relative path — the last '/'-separated segment.
fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// Attach `Authorization: Bearer <token>` when a non-empty HF token is set.
/// Used on every catalog request so authenticated users skip anonymous
/// throttling, get the faster download path, and can reach gated repos.
fn with_auth(req: ureq::Request, token: Option<&str>) -> ureq::Request {
    match token {
        Some(t) if !t.trim().is_empty() => {
            req.set("Authorization", &format!("Bearer {}", t.trim()))
        }
        _ => req,
    }
}

/// Strip a trailing `-GGUF`/`-gguf` so quant-tag extraction sees the model name.
fn clean_model_name(repo_name: &str) -> String {
    for suffix in ["-GGUF", "-gguf", "-Gguf"] {
        if let Some(rest) = repo_name.strip_suffix(suffix) {
            return rest.to_string();
        }
    }
    repo_name.to_string()
}

/// Parse a split-shard filename into `(base, index, total)`, e.g.
/// "Foo-Q4_K_M-00001-of-00009.gguf" → ("Foo-Q4_K_M", 1, 9). Returns None for a
/// non-split `.gguf` name.
fn split_part(name: &str) -> Option<(String, u32, u32)> {
    let stem = name
        .strip_suffix(".gguf")
        .or_else(|| name.strip_suffix(".GGUF"))?;
    let of_idx = stem.rfind("-of-")?;
    let total: u32 = stem[of_idx + 4..].parse().ok()?;
    let left = &stem[..of_idx];
    let dash = left.rfind('-')?;
    let idx: u32 = left[dash + 1..].parse().ok()?;
    let base = &left[..dash];
    if base.is_empty() {
        return None;
    }
    Some((base.to_string(), idx, total))
}

/// Normalize the HF `gated` field into (gated, kind).
fn parse_gated(v: &JsonValue) -> (bool, Option<String>) {
    match v {
        JsonValue::String(s) => (true, Some(s.clone())),
        JsonValue::Bool(b) => (*b, None),
        _ => (false, None),
    }
}

// ── Search ───────────────────────────────────────────────────────────────────

/// Search the HuggingFace Hub for GGUF models. Network I/O, so it runs off the
/// main (STA) thread via `spawn_blocking`.
#[tauri::command]
pub async fn search_catalog(
    query: Option<String>,
    sort: Option<String>,
    limit: Option<u32>,
    token: Option<String>,
) -> Result<Vec<CatalogModel>, String> {
    tauri::async_runtime::spawn_blocking(move || fetch_search(query, sort, limit, token))
        .await
        .map_err(|e| format!("search_catalog task failed: {e}"))?
}

fn normalize_sort(sort: Option<String>) -> &'static str {
    match sort.as_deref() {
        Some("likes") => "likes",
        Some("lastModified") | Some("modified") => "lastModified",
        Some("trending") | Some("trendingScore") => "trendingScore",
        Some("created") | Some("createdAt") => "createdAt",
        _ => "downloads",
    }
}

fn fetch_search(
    query: Option<String>,
    sort: Option<String>,
    limit: Option<u32>,
    token: Option<String>,
) -> Result<Vec<CatalogModel>, String> {
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let sort = normalize_sort(sort);
    let mut req = ureq::get(SEARCH_URL)
        .set("User-Agent", USER_AGENT)
        .set("Accept", "application/json")
        .timeout(Duration::from_secs(30))
        .query("filter", "gguf")
        .query("sort", sort)
        .query("direction", "-1")
        .query("limit", &limit.to_string())
        .query("full", "true");
    if let Some(q) = query.as_deref() {
        let q = q.trim();
        if !q.is_empty() {
            req = req.query("search", q);
        }
    }
    info!("catalog: searching gguf models sort={sort} limit={limit}");
    let resp = with_auth(req, token.as_deref())
        .call()
        .map_err(map_hf_err)?;
    let models: Vec<HfModel> = resp
        .into_json()
        .map_err(|e| format!("parse search JSON: {e}"))?;

    let out = models
        .into_iter()
        .map(|m| {
            // Owner is the repo-id prefix — the directory the download lands in
            // and the name the models scanner reports — NOT HuggingFace's
            // free-form `author` field (which can differ in case/value). Keying
            // "in library" detection on this keeps both sides aligned.
            let (owner, name) = match m.id.split_once('/') {
                Some((o, n)) => (o.to_string(), n.to_string()),
                None => (m.author.clone().unwrap_or_default(), m.id.clone()),
            };
            let (gated, gated_kind) = parse_gated(&m.gated);
            let gguf_count = m
                .siblings
                .iter()
                .filter(|s| s.rfilename.to_lowercase().ends_with(".gguf"))
                .count();
            CatalogModel {
                params: guess_params(&name),
                owner,
                name: name.clone(),
                id: m.id,
                downloads: m.downloads,
                likes: m.likes,
                gated,
                gated_kind,
                pipeline_tag: m.pipeline_tag,
                library_name: m.library_name,
                last_modified: m.last_modified,
                tags: m.tags,
                gguf_count,
            }
        })
        .collect();
    Ok(out)
}

// ── File listing ─────────────────────────────────────────────────────────────

/// List the GGUF quants in a repo, grouping split shards. Network I/O.
#[tauri::command]
pub async fn list_catalog_files(
    repo_id: String,
    token: Option<String>,
) -> Result<Vec<CatalogFile>, String> {
    if !valid_repo_id(&repo_id) {
        return Err(format!("invalid repo id: {repo_id}"));
    }
    tauri::async_runtime::spawn_blocking(move || fetch_files(&repo_id, token.as_deref()))
        .await
        .map_err(|e| format!("list_catalog_files task failed: {e}"))?
}

/// A single shard collected before grouping.
struct Shard {
    url_path: String,
    local: String,
    size: u64,
}

fn fetch_files(repo_id: &str, token: Option<&str>) -> Result<Vec<CatalogFile>, String> {
    let url = format!("https://huggingface.co/api/models/{repo_id}/tree/main?recursive=true");
    info!("catalog: listing files for {repo_id}");
    let req = ureq::get(&url)
        .set("User-Agent", USER_AGENT)
        .set("Accept", "application/json")
        .timeout(Duration::from_secs(30));
    let resp = with_auth(req, token).call().map_err(map_hf_err)?;
    let entries: Vec<HfTreeEntry> = resp
        .into_json()
        .map_err(|e| format!("parse tree JSON: {e}"))?;

    let repo_name = repo_id.split('/').next_back().unwrap_or(repo_id);
    let model_name = clean_model_name(repo_name);

    // Group by quant base name (split shards collapse into one group). The inner
    // BTreeMap keys parts by shard index so they come out ordered + de-duped.
    let mut groups: BTreeMap<String, BTreeMap<u32, Shard>> = BTreeMap::new();
    for e in entries {
        if e.kind != "file" || !valid_gguf_path(&e.path) {
            continue;
        }
        let local = basename(&e.path).to_string();
        let size = e
            .lfs
            .as_ref()
            .map(|l| l.size)
            .filter(|s| *s > 0)
            .unwrap_or(e.size);
        let (base, idx) = match split_part(&local) {
            Some((b, i, _)) => (b, i),
            None => (local.trim_end_matches(".gguf").to_string(), 1),
        };
        groups.entry(base).or_default().insert(
            idx,
            Shard {
                url_path: e.path,
                local,
                size,
            },
        );
    }

    let mut files: Vec<CatalogFile> = groups
        .into_iter()
        .map(|(base, parts)| {
            let shards: Vec<Shard> = parts.into_values().collect();
            let total: u64 = shards.iter().map(|s| s.size).sum();
            let rep = shards[0].local.clone();
            let n_parts = shards.len();
            let is_split = n_parts > 1;
            let tag = extract_quant_tag(&format!("{base}.gguf"), &model_name);
            let bits = parse_bits(&tag);
            let (badges, _) = detect_badges(&tag, &rep);
            let is_mmproj = is_mmproj_filename(&rep);
            CatalogFile {
                filename: rep,
                tag,
                bits,
                size: total,
                size_gb: total as f64 / 1024.0 / 1024.0 / 1024.0,
                badges,
                is_split,
                n_parts,
                url_paths: shards.into_iter().map(|s| s.url_path).collect(),
                is_mmproj,
            }
        })
        .collect();

    // mmproj projectors last; otherwise smallest bit-depth first, then tag.
    files.sort_by(|a, b| {
        a.is_mmproj
            .cmp(&b.is_mmproj)
            .then(a.bits.cmp(&b.bits))
            .then(a.tag.cmp(&b.tag))
    });
    info!("catalog: {repo_id} → {} quants", files.len());
    Ok(files)
}

// ── Download ─────────────────────────────────────────────────────────────────

fn models_root(app: &AppHandle, models_dir: Option<String>) -> Result<PathBuf, String> {
    if let Some(d) = models_dir {
        if !d.trim().is_empty() {
            return Ok(PathBuf::from(d));
        }
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("models");
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir models: {e}"))?;
    Ok(dir)
}

/// Start downloading a quant (all its parts) into the models library. Returns
/// immediately with the run's generation id; progress arrives via
/// `catalog-progress` and the terminal result via a single `catalog-done`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn download_catalog_model(
    app: AppHandle,
    state: State<'_, CatalogState>,
    repo_id: String,
    filename: String,
    url_paths: Vec<String>,
    expected_size: Option<u64>,
    models_dir: Option<String>,
    token: Option<String>,
) -> Result<u64, String> {
    if !valid_repo_id(&repo_id) {
        return Err(format!("invalid repo id: {repo_id}"));
    }
    if url_paths.is_empty() {
        return Err("no files to download".into());
    }
    for p in &url_paths {
        if !valid_gguf_path(p) {
            return Err(format!("unsafe file path: {p}"));
        }
    }
    if state
        .busy
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("a download is already running".into());
    }
    state.cancel.store(false, Ordering::SeqCst);
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;

    let root = match models_root(&app, models_dir) {
        Ok(r) => r,
        Err(e) => {
            state.busy.store(false, Ordering::SeqCst);
            return Err(e);
        }
    };
    info!(
        "catalog: download gen {generation} {repo_id} ({} part(s)) → {}",
        url_paths.len(),
        root.display()
    );

    let busy = state.busy.clone();
    let cancel = state.cancel.clone();
    let gen_arc = state.generation.clone();
    let total_hint = expected_size.unwrap_or(0);

    std::thread::spawn(move || {
        // Catch any worker panic so `busy` is ALWAYS released and a terminal
        // `catalog-done` is ALWAYS emitted — otherwise a panic would brick all
        // future downloads and leave the UI stuck on "downloading".
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run_download(
                &app,
                &root,
                &repo_id,
                &url_paths,
                total_hint,
                &filename,
                token.as_deref(),
                generation,
                &gen_arc,
                &cancel,
            )
        }))
        .unwrap_or_else(|_| Err("download worker panicked".to_string()));
        let cancelled = cancel.load(Ordering::SeqCst);
        busy.store(false, Ordering::SeqCst);

        let done = match result {
            Ok((dest_root, model_path)) => CatalogDone {
                generation,
                repo_id: repo_id.clone(),
                filename: filename.clone(),
                ok: true,
                cancelled: false,
                error: None,
                dest_root: Some(dest_root),
                model_path: Some(model_path),
            },
            Err(e) if cancelled => {
                debug!("catalog: download gen {generation} cancelled ({e})");
                CatalogDone {
                    generation,
                    repo_id: repo_id.clone(),
                    filename: filename.clone(),
                    ok: false,
                    cancelled: true,
                    error: None,
                    dest_root: None,
                    model_path: None,
                }
            }
            Err(e) => {
                warn!("catalog: download gen {generation} failed: {e}");
                CatalogDone {
                    generation,
                    repo_id: repo_id.clone(),
                    filename: filename.clone(),
                    ok: false,
                    cancelled: false,
                    error: Some(e),
                    dest_root: None,
                    model_path: None,
                }
            }
        };
        let _ = app.emit("catalog-done", done);
    });

    Ok(generation)
}

#[allow(clippy::too_many_arguments)]
fn run_download(
    app: &AppHandle,
    root: &Path,
    repo_id: &str,
    url_paths: &[String],
    total_hint: u64,
    filename: &str,
    token: Option<&str>,
    generation: u64,
    gen_arc: &AtomicU64,
    cancel: &AtomicBool,
) -> Result<(String, String), String> {
    let (owner, repo_name) = repo_id
        .split_once('/')
        .ok_or_else(|| "bad repo id".to_string())?;
    let model_dir = root.join(owner).join(repo_name);
    fs::create_dir_all(&model_dir).map_err(|e| format!("mkdir model dir: {e}"))?;

    // Local filenames for every part (validated by the caller).
    let locals: Vec<String> = url_paths.iter().map(|p| basename(p).to_string()).collect();
    let part_files: Vec<PathBuf> = locals
        .iter()
        .map(|l| model_dir.join(format!("{l}.part")))
        .collect();
    // Fresh start — clear stale partials from a previous attempt.
    for pf in &part_files {
        let _ = fs::remove_file(pf);
    }

    // Finals this run has already promoted from `.part`, so an error or cancel
    // partway through finalize can be fully rolled back.
    let mut promoted: Vec<PathBuf> = Vec::new();
    let outcome = download_parts(
        app,
        &model_dir,
        repo_id,
        url_paths,
        &locals,
        &part_files,
        total_hint,
        filename,
        token,
        generation,
        gen_arc,
        cancel,
        &mut promoted,
    );

    match outcome {
        Ok(()) => {
            let model_path = model_dir.join(&locals[0]).to_string_lossy().into_owned();
            info!(
                "catalog: installed {repo_id}/{} ({} part(s))",
                locals[0],
                url_paths.len()
            );
            Ok((root.to_string_lossy().into_owned(), model_path))
        }
        Err(e) => {
            // On ANY failure (error or cancel), undo this run's artifacts so the
            // scanner never adopts a truncated or partially-finalized model.
            // Only this download's own files are touched (named partials + the
            // finals it promoted), so sibling quants in the dir are left intact.
            for p in promoted.iter().chain(part_files.iter()) {
                let _ = fs::remove_file(p);
            }
            // Drop the model dir only if our cleanup left it empty.
            let _ = fs::remove_dir(&model_dir);
            Err(e)
        }
    }
}

/// Download every shard to `<name>.part`, verify each against the server's
/// Content-Length, then atomically promote each to its final `.gguf`. Records
/// promoted finals in `promoted` so the caller can roll back on failure. The
/// integrity check matters because a clean mid-transfer connection close looks
/// like a normal EOF — without it a truncated `.part` would be promoted to a
/// scannable-but-unloadable model.
#[allow(clippy::too_many_arguments)]
fn download_parts(
    app: &AppHandle,
    model_dir: &Path,
    repo_id: &str,
    url_paths: &[String],
    locals: &[String],
    part_files: &[PathBuf],
    total_hint: u64,
    filename: &str,
    token: Option<&str>,
    generation: u64,
    gen_arc: &AtomicU64,
    cancel: &AtomicBool,
    promoted: &mut Vec<PathBuf>,
) -> Result<(), String> {
    let aborted = || cancel.load(Ordering::SeqCst) || gen_arc.load(Ordering::SeqCst) != generation;

    // Per-operation timeouts (connect + idle read), NOT an overall deadline: a
    // multi-GB model can take a long time on a slow link. HF resolve URLs
    // redirect to a CDN, so allow a generous redirect budget.
    //
    // `redirect_auth_headers(Never)` (also the ureq default) is pinned
    // deliberately: the HF token must reach only huggingface.co (the resolve
    // endpoint that authorizes the request), and must NOT be forwarded to the
    // presigned CDN URL the redirect points at — that would leak the credential
    // and can trigger a 400 "multiple auth mechanisms" on gated downloads.
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(20))
        .timeout_read(Duration::from_secs(60))
        .redirects(10)
        .redirect_auth_headers(ureq::RedirectAuthHeaders::Never)
        .build();

    let n = url_paths.len();
    let mut downloaded: u64 = 0;
    let mut last_emit: u64 = 0;
    let emit = |downloaded: u64, part: usize| {
        let _ = app.emit(
            "catalog-progress",
            CatalogProgress {
                generation,
                repo_id: repo_id.to_string(),
                filename: filename.to_string(),
                downloaded,
                total: total_hint.max(downloaded),
                part,
                parts: n,
            },
        );
    };

    for (i, url_path) in url_paths.iter().enumerate() {
        if aborted() {
            return Err("cancelled".into());
        }
        let url = format!("https://huggingface.co/{repo_id}/resolve/main/{url_path}");
        let resp = with_auth(agent.get(&url).set("User-Agent", USER_AGENT), token)
            .call()
            .map_err(map_hf_err)?;
        if aborted() {
            return Err("cancelled".into());
        }
        // The CDN reports the exact byte length; we hold each shard to it below.
        let content_length = resp
            .header("Content-Length")
            .and_then(|s| s.parse::<u64>().ok());
        let mut reader = resp.into_reader();
        let mut file =
            fs::File::create(&part_files[i]).map_err(|e| format!("create part file: {e}"))?;
        let mut buf = vec![0u8; 64 * 1024];
        let mut part_bytes: u64 = 0;
        loop {
            if aborted() {
                return Err("cancelled".into());
            }
            let r = reader
                .read(&mut buf)
                .map_err(|e| format!("read body: {e}"))?;
            if r == 0 {
                break;
            }
            file.write_all(&buf[..r])
                .map_err(|e| format!("write part: {e}"))?;
            part_bytes += r as u64;
            downloaded += r as u64;
            if downloaded - last_emit >= PROGRESS_STEP {
                last_emit = downloaded;
                emit(downloaded, i + 1);
            }
        }
        file.flush().map_err(|e| format!("flush part: {e}"))?;
        // Integrity gate: reject a short read (a clean mid-stream close would
        // otherwise surface as a normal EOF and yield a truncated file).
        if let Some(cl) = content_length {
            if part_bytes != cl {
                return Err(format!(
                    "incomplete download: got {part_bytes} of {cl} bytes for {}",
                    locals[i]
                ));
            }
        }
        emit(downloaded, i + 1);
    }

    // Secondary floor for the (rare) case a shard arrived with no Content-Length:
    // the tree API's summed LFS size must at least be met.
    if total_hint > 0 && downloaded < total_hint {
        return Err(format!(
            "incomplete download: got {downloaded} of {total_hint} expected bytes"
        ));
    }

    // All parts verified — promote each `.part` to its final name, recording
    // promotions so a mid-loop rename failure can be rolled back by the caller.
    for (i, local) in locals.iter().enumerate() {
        let final_path = model_dir.join(local);
        let _ = fs::remove_file(&final_path);
        fs::rename(&part_files[i], &final_path).map_err(|e| format!("finalize {local}: {e}"))?;
        promoted.push(final_path);
    }
    Ok(())
}

/// Signal the in-flight download to stop. The worker cleans up partials and
/// emits the terminal `catalog-done`.
#[tauri::command]
pub fn cancel_catalog_download(state: State<'_, CatalogState>) -> Result<(), String> {
    state.cancel.store(true, Ordering::SeqCst);
    Ok(())
}

/// Map a ureq error to a user-facing message, calling out the common
/// gated/rate-limit cases.
fn map_hf_err(e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(401, _) => {
            "401 — this model is gated or private. Accept its terms on huggingface.co first (access tokens aren't supported yet).".to_string()
        }
        ureq::Error::Status(403, _) => {
            "403 — access to this model is restricted, or the HuggingFace rate limit was hit. Try again later.".to_string()
        }
        ureq::Error::Status(404, _) => "404 — not found (the repo or file may have moved).".to_string(),
        ureq::Error::Status(429, _) => {
            "429 — HuggingFace rate limit reached. Try again in a bit.".to_string()
        }
        other => format!("request failed: {other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn safe_segment_rejects_traversal_and_separators() {
        assert!(is_safe_segment("Qwen2.5-7B-Instruct-Q4_K_M.gguf"));
        assert!(is_safe_segment("owner_name"));
        assert!(!is_safe_segment(""));
        assert!(!is_safe_segment(".."));
        assert!(!is_safe_segment("a..b"));
        assert!(!is_safe_segment("a/b"));
        assert!(!is_safe_segment("a\\b"));
        assert!(!is_safe_segment("a b"));
    }

    #[test]
    fn valid_repo_id_requires_one_slash() {
        assert!(valid_repo_id("bartowski/Llama-3.2-1B-Instruct-GGUF"));
        assert!(valid_repo_id("unsloth/Qwen2.5-7B"));
        assert!(!valid_repo_id("noslash"));
        assert!(!valid_repo_id("too/many/slashes"));
        assert!(!valid_repo_id("../escape/x"));
        assert!(!valid_repo_id("owner/"));
    }

    #[test]
    fn valid_gguf_path_accepts_subdirs_rejects_escapes() {
        assert!(valid_gguf_path("model-Q4_K_M.gguf"));
        assert!(valid_gguf_path("Q4_K_M/model-00001-of-00002.gguf"));
        assert!(valid_gguf_path("a.GGUF"));
        assert!(!valid_gguf_path("model.bin"));
        assert!(!valid_gguf_path("../secret.gguf"));
        assert!(!valid_gguf_path("/abs/path.gguf"));
        assert!(!valid_gguf_path("dir/../x.gguf"));
    }

    #[test]
    fn basename_takes_last_segment() {
        assert_eq!(basename("a/b/c.gguf"), "c.gguf");
        assert_eq!(basename("c.gguf"), "c.gguf");
    }

    #[test]
    fn clean_model_name_strips_gguf_suffix() {
        assert_eq!(
            clean_model_name("Llama-3.2-1B-Instruct-GGUF"),
            "Llama-3.2-1B-Instruct"
        );
        assert_eq!(clean_model_name("Qwen2.5-7B-gguf"), "Qwen2.5-7B");
        assert_eq!(clean_model_name("PlainName"), "PlainName");
    }

    #[test]
    fn split_part_parses_shards() {
        let (base, idx, total) = split_part("Foo-Q4_K_M-00001-of-00009.gguf").unwrap();
        assert_eq!(base, "Foo-Q4_K_M");
        assert_eq!(idx, 1);
        assert_eq!(total, 9);
        let (b2, i2, t2) = split_part("Qwen2-72B-Instruct-Q5_K_M-00003-of-00003.gguf").unwrap();
        assert_eq!(b2, "Qwen2-72B-Instruct-Q5_K_M");
        assert_eq!(i2, 3);
        assert_eq!(t2, 3);
    }

    #[test]
    fn split_part_none_for_single_file() {
        assert!(split_part("Foo-Q4_K_M.gguf").is_none());
        assert!(split_part("model.gguf").is_none());
        // "-of-" without a numeric shard index isn't a split shard.
        assert!(split_part("tower-of-babel.gguf").is_none());
    }

    #[test]
    fn parse_gated_handles_bool_and_string() {
        assert_eq!(parse_gated(&json!(false)), (false, None));
        assert_eq!(parse_gated(&json!(true)), (true, None));
        assert_eq!(
            parse_gated(&json!("auto")),
            (true, Some("auto".to_string()))
        );
        assert_eq!(
            parse_gated(&json!("manual")),
            (true, Some("manual".to_string()))
        );
        assert_eq!(parse_gated(&json!(null)), (false, None));
    }

    #[test]
    fn normalize_sort_allowlists() {
        assert_eq!(normalize_sort(Some("likes".into())), "likes");
        assert_eq!(normalize_sort(Some("lastModified".into())), "lastModified");
        assert_eq!(normalize_sort(Some("trending".into())), "trendingScore");
        assert_eq!(normalize_sort(Some("garbage".into())), "downloads");
        assert_eq!(normalize_sort(None), "downloads");
    }
}
