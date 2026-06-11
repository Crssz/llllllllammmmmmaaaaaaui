//! Workspace file tools: sandboxed list/read/search/find/write/edit commands
//! rooted at a user-picked project folder. These back the chat's built-in
//! `workspace__*` tools so a local model can read and edit a codebase the way
//! a coding agent does. Every path is resolved against the chosen root and
//! anything that escapes it (lexically or through a symlink) is rejected.
//!
//! Commands are `async` so the directory walks run on Tauri's worker pool
//! instead of blocking the main thread.

use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

/// Dependency/build directories skipped when walking the tree for search and
/// find — matches there would drown out useful results.
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "coverage",
    "__pycache__",
    "venv",
    ".venv",
];

/// Hidden directories are skipped too (".git" being the important one), with
/// an allowlist for the ones that actually hold source.
const KEEP_HIDDEN: &[&str] = &[".github"];

/// Default / maximum number of lines a single read returns. Local models run
/// with small contexts, so the default stays modest; the model can page with
/// `offset` + `limit`.
const DEFAULT_READ_LIMIT: usize = 400;
const MAX_READ_LIMIT: usize = 2000;
/// Hard byte cap per read so a minified bundle can't blow the context.
const MAX_READ_BYTES: usize = 200 * 1024;
const DEFAULT_MAX_RESULTS: usize = 100;
const MAX_MAX_RESULTS: usize = 500;
/// Upper bound on files visited per walk so pointing the workspace at a huge
/// tree (or a whole drive) can't spin forever.
const MAX_WALK_FILES: usize = 25_000;
/// Content search skips files bigger than this.
const MAX_SEARCH_FILE_BYTES: u64 = 1_500_000;
/// Search match lines are trimmed to this many characters.
const MAX_MATCH_CHARS: usize = 240;

#[derive(Debug, Clone, Serialize)]
pub struct WsEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct WsRead {
    pub path: String,
    pub total_lines: usize,
    pub start_line: usize,
    pub end_line: usize,
    pub truncated: bool,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct WsWrite {
    pub path: String,
    pub bytes: usize,
    pub created: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct WsEdit {
    pub path: String,
    pub replacements: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct WsMatch {
    pub path: String,
    pub line: usize,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct WsSearch {
    pub matches: Vec<WsMatch>,
    pub truncated: bool,
    pub files_scanned: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct WsFind {
    pub paths: Vec<String>,
    pub truncated: bool,
}

/// Canonicalize the workspace root, requiring an existing directory.
fn canon_root(root: &str) -> Result<PathBuf, String> {
    let p = Path::new(root);
    if !p.is_absolute() {
        return Err("workspace root must be an absolute path".into());
    }
    let canon = fs::canonicalize(p).map_err(|e| format!("workspace root: {e}"))?;
    if !canon.is_dir() {
        return Err("workspace root is not a directory".into());
    }
    Ok(canon)
}

/// Resolve a model-supplied relative path against the canonical root. The
/// path is normalized lexically (`.`/`..` folded, absolute/prefixed forms
/// rejected) and, when the target already exists, re-checked through
/// `canonicalize` so symlinks can't escape the root either.
fn resolve(root: &Path, rel: &str) -> Result<PathBuf, String> {
    // Tolerate a leading slash — models often write "/src/main.rs" meaning
    // "relative to the project root".
    let rel = rel.trim().trim_start_matches(['/', '\\']);
    let mut depth: i32 = 0;
    let mut out = root.to_path_buf();
    for comp in Path::new(rel).components() {
        match comp {
            Component::Normal(c) => {
                out.push(c);
                depth += 1;
            }
            Component::CurDir => {}
            Component::ParentDir => {
                depth -= 1;
                if depth < 0 {
                    return Err(format!("path escapes the workspace root: {rel}"));
                }
                out.pop();
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(format!(
                    "path must be relative to the workspace root: {rel}"
                ));
            }
        }
    }
    if out.exists() {
        let canon = fs::canonicalize(&out).map_err(|e| format!("resolve {rel}: {e}"))?;
        if !canon.starts_with(root) {
            return Err(format!("path escapes the workspace root: {rel}"));
        }
        return Ok(canon);
    }
    Ok(out)
}

/// Render a path relative to the root with forward slashes — what the model
/// sees and what it should pass back in later calls.
fn rel_display(root: &Path, p: &Path) -> String {
    p.strip_prefix(root)
        .map(|r| r.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| p.to_string_lossy().into_owned())
}

fn should_skip_dir(name: &str) -> bool {
    if KEEP_HIDDEN.contains(&name) {
        return false;
    }
    name.starts_with('.') || SKIP_DIRS.contains(&name)
}

/// Depth-first walk collecting file paths, skipping dependency/hidden dirs.
/// Returns true when the walk ran out of budget (tree truncated).
fn walk_files(dir: &Path, out: &mut Vec<PathBuf>, budget: &mut usize) -> bool {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return false,
    };
    let mut names: Vec<(PathBuf, bool)> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let ft = e.file_type().ok()?;
            Some((e.path(), ft.is_dir()))
        })
        .collect();
    names.sort_by(|a, b| a.0.cmp(&b.0));
    for (path, is_dir) in names {
        if *budget == 0 {
            return true;
        }
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if is_dir {
            if should_skip_dir(&name) {
                continue;
            }
            if walk_files(&path, out, budget) {
                return true;
            }
        } else {
            *budget -= 1;
            out.push(path);
        }
    }
    false
}

fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|b| *b == 0)
}

/// Case-insensitive `*`-wildcard match. A pattern without `*` matches as a
/// substring, mirroring what people expect from a quick filename filter.
fn wildcard_match(pattern: &str, value: &str) -> bool {
    let pat = pattern.to_lowercase();
    let val = value.to_lowercase();
    if !pat.contains('*') {
        return val.contains(&pat);
    }
    let parts: Vec<&str> = pat.split('*').collect();
    let mut pos = 0usize;
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() {
            continue;
        }
        if i == 0 {
            if !val.starts_with(part) {
                return false;
            }
            pos = part.len();
        } else if let Some(found) = val[pos..].find(part) {
            pos += found + part.len();
        } else {
            return false;
        }
    }
    // A pattern not ending in `*` must match through the end of the value.
    if let Some(last) = parts.last() {
        if !last.is_empty() && !val.ends_with(last) {
            return false;
        }
    }
    true
}

fn clamp_results(max_results: Option<usize>) -> usize {
    max_results
        .unwrap_or(DEFAULT_MAX_RESULTS)
        .clamp(1, MAX_MAX_RESULTS)
}

// ── Command implementations (sync, unit-tested directly) ────────────────────

fn list_impl(root: &str, path: &str) -> Result<Vec<WsEntry>, String> {
    let root = canon_root(root)?;
    let dir = resolve(&root, path)?;
    if !dir.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    let mut entries: Vec<WsEntry> = fs::read_dir(&dir)
        .map_err(|e| format!("list {path}: {e}"))?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            Some(WsEntry {
                name: e.file_name().to_string_lossy().into_owned(),
                is_dir: meta.is_dir(),
                size: if meta.is_dir() { 0 } else { meta.len() },
            })
        })
        .collect();
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

fn read_impl(
    root: &str,
    path: &str,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<WsRead, String> {
    let root = canon_root(root)?;
    let file = resolve(&root, path)?;
    if !file.is_file() {
        return Err(format!("not a file: {path}"));
    }
    let bytes = fs::read(&file).map_err(|e| format!("read {path}: {e}"))?;
    if looks_binary(&bytes) {
        return Err(format!("binary file, refusing to read: {path}"));
    }
    let text = String::from_utf8_lossy(&bytes);
    let lines: Vec<&str> = text.lines().collect();
    let total = lines.len();
    let start = offset.unwrap_or(1).max(1);
    let limit = limit.unwrap_or(DEFAULT_READ_LIMIT).clamp(1, MAX_READ_LIMIT);
    if start > total && total > 0 {
        return Err(format!(
            "offset {start} is past the end of {path} ({total} lines)"
        ));
    }
    let mut out = String::new();
    let mut end = start.saturating_sub(1);
    let mut byte_truncated = false;
    for (i, line) in lines.iter().enumerate().skip(start - 1).take(limit) {
        if out.len() + line.len() + 1 > MAX_READ_BYTES {
            byte_truncated = true;
            break;
        }
        out.push_str(line);
        out.push('\n');
        end = i + 1;
    }
    let truncated = byte_truncated || end < total;
    Ok(WsRead {
        path: rel_display(&root, &file),
        total_lines: total,
        start_line: start.min(total.max(1)),
        end_line: end,
        truncated,
        content: out,
    })
}

fn write_impl(root: &str, path: &str, content: &str) -> Result<WsWrite, String> {
    let root = canon_root(root)?;
    let file = resolve(&root, path)?;
    if file == root {
        return Err("path must name a file inside the workspace".into());
    }
    if file.is_dir() {
        return Err(format!("a directory exists at: {path}"));
    }
    let created = !file.exists();
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir for {path}: {e}"))?;
    }
    fs::write(&file, content).map_err(|e| format!("write {path}: {e}"))?;
    Ok(WsWrite {
        path: rel_display(&root, &file),
        bytes: content.len(),
        created,
    })
}

fn edit_impl(
    root: &str,
    path: &str,
    old_string: &str,
    new_string: &str,
    replace_all: bool,
) -> Result<WsEdit, String> {
    if old_string.is_empty() {
        return Err("old_string must not be empty".into());
    }
    if old_string == new_string {
        return Err("old_string and new_string are identical".into());
    }
    let root = canon_root(root)?;
    let file = resolve(&root, path)?;
    if !file.is_file() {
        return Err(format!("not a file: {path}"));
    }
    let bytes = fs::read(&file).map_err(|e| format!("read {path}: {e}"))?;
    if looks_binary(&bytes) {
        return Err(format!("binary file, refusing to edit: {path}"));
    }
    let text = String::from_utf8(bytes).map_err(|_| format!("not valid UTF-8: {path}"))?;
    let count = text.matches(old_string).count();
    if count == 0 {
        return Err(format!(
            "old_string not found in {path} — read the file and copy the exact text"
        ));
    }
    if count > 1 && !replace_all {
        return Err(format!(
            "old_string occurs {count} times in {path} — extend it to be unique or set replace_all=true"
        ));
    }
    let (next, replacements) = if replace_all {
        (text.replace(old_string, new_string), count)
    } else {
        (text.replacen(old_string, new_string, 1), 1)
    };
    fs::write(&file, next).map_err(|e| format!("write {path}: {e}"))?;
    Ok(WsEdit {
        path: rel_display(&root, &file),
        replacements,
    })
}

fn search_impl(
    root: &str,
    query: &str,
    path: Option<&str>,
    max_results: Option<usize>,
) -> Result<WsSearch, String> {
    if query.trim().is_empty() {
        return Err("query must not be empty".into());
    }
    let root = canon_root(root)?;
    let base = resolve(&root, path.unwrap_or(""))?;
    if !base.is_dir() {
        return Err("search path is not a directory".into());
    }
    let max = clamp_results(max_results);
    let needle = query.to_lowercase();
    let mut files = Vec::new();
    let mut budget = MAX_WALK_FILES;
    walk_files(&base, &mut files, &mut budget);
    let mut matches = Vec::new();
    let mut truncated = false;
    let mut scanned = 0usize;
    'outer: for f in &files {
        let Ok(meta) = f.metadata() else { continue };
        if meta.len() > MAX_SEARCH_FILE_BYTES {
            continue;
        }
        let Ok(bytes) = fs::read(f) else { continue };
        if looks_binary(&bytes) {
            continue;
        }
        scanned += 1;
        let text = String::from_utf8_lossy(&bytes);
        for (i, line) in text.lines().enumerate() {
            if line.to_lowercase().contains(&needle) {
                let trimmed: String = line.trim().chars().take(MAX_MATCH_CHARS).collect();
                matches.push(WsMatch {
                    path: rel_display(&root, f),
                    line: i + 1,
                    text: trimmed,
                });
                if matches.len() >= max {
                    truncated = true;
                    break 'outer;
                }
            }
        }
    }
    Ok(WsSearch {
        matches,
        truncated,
        files_scanned: scanned,
    })
}

fn find_impl(root: &str, pattern: &str, max_results: Option<usize>) -> Result<WsFind, String> {
    if pattern.trim().is_empty() {
        return Err("pattern must not be empty".into());
    }
    let root = canon_root(root)?;
    let max = clamp_results(max_results);
    let mut files = Vec::new();
    let mut budget = MAX_WALK_FILES;
    walk_files(&root, &mut files, &mut budget);
    // Patterns with a path separator match the whole relative path; bare
    // patterns match the filename only.
    let against_path = pattern.contains('/') || pattern.contains('\\');
    let pattern = pattern.replace('\\', "/");
    let mut paths = Vec::new();
    let mut truncated = false;
    for f in &files {
        let rel = rel_display(&root, f);
        let candidate = if against_path {
            rel.as_str()
        } else {
            rel.rsplit('/').next().unwrap_or(rel.as_str())
        };
        if wildcard_match(&pattern, candidate) {
            paths.push(rel);
            if paths.len() >= max {
                truncated = true;
                break;
            }
        }
    }
    Ok(WsFind { paths, truncated })
}

// ── Tauri commands (async → worker pool, not the main thread) ───────────────

#[tauri::command]
pub async fn workspace_list(root: String, path: String) -> Result<Vec<WsEntry>, String> {
    list_impl(&root, &path)
}

#[tauri::command]
pub async fn workspace_read(
    root: String,
    path: String,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<WsRead, String> {
    read_impl(&root, &path, offset, limit)
}

#[tauri::command]
pub async fn workspace_write(
    root: String,
    path: String,
    content: String,
) -> Result<WsWrite, String> {
    write_impl(&root, &path, &content)
}

#[tauri::command]
pub async fn workspace_edit(
    root: String,
    path: String,
    old_string: String,
    new_string: String,
    replace_all: Option<bool>,
) -> Result<WsEdit, String> {
    edit_impl(
        &root,
        &path,
        &old_string,
        &new_string,
        replace_all.unwrap_or(false),
    )
}

#[tauri::command]
pub async fn workspace_search(
    root: String,
    query: String,
    path: Option<String>,
    max_results: Option<usize>,
) -> Result<WsSearch, String> {
    search_impl(&root, &query, path.as_deref(), max_results)
}

#[tauri::command]
pub async fn workspace_find(
    root: String,
    pattern: String,
    max_results: Option<usize>,
) -> Result<WsFind, String> {
    find_impl(&root, &pattern, max_results)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a unique temp workspace with a small project tree.
    fn temp_ws(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "llammaui-ws-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::create_dir_all(dir.join("node_modules/dep")).unwrap();
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::write(dir.join("README.md"), "# Demo\nhello world\n").unwrap();
        fs::write(
            dir.join("src/main.rs"),
            "fn main() {\n    println!(\"hello\");\n}\n",
        )
        .unwrap();
        fs::write(dir.join("src/lib.rs"), "pub fn add(a: i32) -> i32 { a }\n").unwrap();
        fs::write(dir.join("node_modules/dep/index.js"), "hello world\n").unwrap();
        fs::write(dir.join(".git/config"), "hello world\n").unwrap();
        dir
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn resolve_rejects_traversal_and_absolute_paths() {
        let dir = temp_ws("resolve");
        let root = s(&dir);
        assert!(read_impl(&root, "../outside.txt", None, None).is_err());
        assert!(read_impl(&root, "src/../../outside.txt", None, None).is_err());
        assert!(write_impl(&root, "C:\\Windows\\evil.txt", "x").is_err());
        // `a/../b` stays inside and is fine.
        assert!(read_impl(&root, "src/../README.md", None, None).is_ok());
        // Leading slash is tolerated as "from the root".
        assert!(read_impl(&root, "/README.md", None, None).is_ok());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_sorts_dirs_first() {
        let dir = temp_ws("list");
        let entries = list_impl(&s(&dir), "").unwrap();
        assert!(entries[0].is_dir);
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"src"));
        assert!(names.contains(&"README.md"));
        assert!(list_impl(&s(&dir), "README.md").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_returns_window_and_flags_truncation() {
        let dir = temp_ws("read");
        let many: String = (1..=50).map(|i| format!("line {i}\n")).collect();
        fs::write(dir.join("big.txt"), many).unwrap();
        let r = read_impl(&s(&dir), "big.txt", Some(10), Some(5)).unwrap();
        assert_eq!(r.start_line, 10);
        assert_eq!(r.end_line, 14);
        assert_eq!(r.total_lines, 50);
        assert!(r.truncated);
        assert!(r.content.starts_with("line 10\n"));
        let full = read_impl(&s(&dir), "big.txt", None, None).unwrap();
        assert!(!full.truncated);
        assert_eq!(full.end_line, 50);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_rejects_binary_and_bad_offset() {
        let dir = temp_ws("readbin");
        fs::write(dir.join("blob.bin"), [0u8, 1, 2, 3]).unwrap();
        assert!(read_impl(&s(&dir), "blob.bin", None, None)
            .unwrap_err()
            .contains("binary"));
        assert!(read_impl(&s(&dir), "README.md", Some(999), None).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_creates_parents_and_reports_created() {
        let dir = temp_ws("write");
        let w = write_impl(&s(&dir), "deep/nested/new.txt", "hi").unwrap();
        assert!(w.created);
        assert_eq!(w.bytes, 2);
        assert_eq!(w.path, "deep/nested/new.txt");
        let w2 = write_impl(&s(&dir), "deep/nested/new.txt", "again").unwrap();
        assert!(!w2.created);
        assert_eq!(
            fs::read_to_string(dir.join("deep/nested/new.txt")).unwrap(),
            "again"
        );
        assert!(write_impl(&s(&dir), "src", "x").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn edit_requires_unique_match_unless_replace_all() {
        let dir = temp_ws("edit");
        fs::write(dir.join("t.txt"), "aaa bbb aaa\n").unwrap();
        let err = edit_impl(&s(&dir), "t.txt", "aaa", "ccc", false).unwrap_err();
        assert!(err.contains("2 times"));
        let one = edit_impl(&s(&dir), "t.txt", "bbb", "BBB", false).unwrap();
        assert_eq!(one.replacements, 1);
        let all = edit_impl(&s(&dir), "t.txt", "aaa", "ccc", true).unwrap();
        assert_eq!(all.replacements, 2);
        assert_eq!(
            fs::read_to_string(dir.join("t.txt")).unwrap(),
            "ccc BBB ccc\n"
        );
        assert!(edit_impl(&s(&dir), "t.txt", "missing", "x", false)
            .unwrap_err()
            .contains("not found"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_finds_lines_and_skips_dep_dirs() {
        let dir = temp_ws("search");
        let r = search_impl(&s(&dir), "hello", None, None).unwrap();
        // node_modules/ and .git/ copies are skipped; README + main.rs hit.
        let paths: Vec<&str> = r.matches.iter().map(|m| m.path.as_str()).collect();
        assert!(paths.contains(&"README.md"));
        assert!(paths.contains(&"src/main.rs"));
        assert!(!paths.iter().any(|p| p.contains("node_modules")));
        assert!(!paths.iter().any(|p| p.contains(".git")));
        let capped = search_impl(&s(&dir), "hello", None, Some(1)).unwrap();
        assert_eq!(capped.matches.len(), 1);
        assert!(capped.truncated);
        let scoped = search_impl(&s(&dir), "hello", Some("src"), None).unwrap();
        assert!(scoped.matches.iter().all(|m| m.path.starts_with("src/")));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn find_matches_names_and_globs() {
        let dir = temp_ws("find");
        let r = find_impl(&s(&dir), "*.rs", None).unwrap();
        assert_eq!(r.paths.len(), 2);
        assert!(r.paths.contains(&"src/main.rs".to_string()));
        let sub = find_impl(&s(&dir), "main", None).unwrap();
        assert_eq!(sub.paths, vec!["src/main.rs".to_string()]);
        let by_path = find_impl(&s(&dir), "src/*.rs", None).unwrap();
        assert_eq!(by_path.paths.len(), 2);
        let none = find_impl(&s(&dir), "*.zig", None).unwrap();
        assert!(none.paths.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn wildcard_match_edges() {
        assert!(wildcard_match("*.rs", "main.rs"));
        assert!(!wildcard_match("*.rs", "main.rs.bak"));
        assert!(wildcard_match("main*", "main.rs"));
        assert!(wildcard_match("ma*in*", "main.rs"));
        assert!(wildcard_match("MAIN", "src-main-x"));
        assert!(!wildcard_match("a*b", "acx"));
    }
}
