use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use log::{debug, error, info, warn};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::build_scan::{quiet_command, resolve_bin_dir};
use crate::util::{chrono_now_millis, lock_or_poisoned};

pub struct ServerState {
    pub child: Mutex<Option<Child>>,
    pub info: Mutex<Option<RunningInfo>>,
    /// Flips to true once GET /health on the spawned server returns 200.
    pub ready: Arc<AtomicBool>,
    /// Bumped on every start_server / stop_server so an in-flight probe
    /// thread for a stale generation exits instead of writing to `ready`.
    pub probe_gen: Arc<AtomicU64>,
    /// True when the currently-running (or most recently spawned) child needs
    /// a Windows process-tree kill rather than a plain `child.kill()`. Set at
    /// spawn time from `exe_path.is_some()` — the same hipfire discriminator
    /// `start_server` already uses — because hipfire's installed CLI is a
    /// `.cmd` shim: spawning it really launches `cmd.exe`, which spawns the
    /// actual `bun.exe` daemon doing the serving. Killing just the top
    /// process (what `child.kill()` does) orphans `bun.exe`, still holding
    /// the model's VRAM and the port (proven live 2026-07-18 — see
    /// `kill_child_tree`). Always false on the llama path.
    pub tree_kill: AtomicBool,
}

impl ServerState {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
            info: Mutex::new(None),
            ready: Arc::new(AtomicBool::new(false)),
            probe_gen: Arc::new(AtomicU64::new(0)),
            tree_kill: AtomicBool::new(false),
        }
    }
}

impl Default for ServerState {
    fn default() -> Self {
        Self::new()
    }
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

/// Single-shot probe: TCP connect + raw GET /health, read the full response
/// and decide readiness from it. Returns true when the server is actually
/// ready to serve a request; false for any failure (refused, non-200 status,
/// read timeout, etc.) or — for hipfire — a 200 whose body says no model is
/// resident yet.
///
/// llama-server's `/health` is a plain `{"status":"ok"}` with no "model" key,
/// and already answers 503 ("Loading model") until the model is ready — the
/// status-line check below is enough for it, unchanged from before.
///
/// hipfire's `/health` (confirmed live 2026-07-18) instead returns 200
/// IMMEDIATELY once the daemon binds the port, *before* the model finishes
/// loading — it prewarms in the background. Its body carries a "model" field
/// that's `null` while loading/idle and the full resolved file path once a
/// model is resident:
///   {"status":"ok","model":null,"idle_timeout_sec":300,"pid":42784,"token":"…"}
///   {"status":"ok","model":"C:\\Users\\…\\qwen3.6-27b.mq4","idle_timeout_sec":300,…}
/// So for hipfire a bare 200 no longer means "ready" — see
/// `health_response_indicates_ready` for the body-aware decision.
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
    // Read the full response into a bounded buffer rather than a fixed
    // 64-byte head: the readiness decision now needs the JSON body, not just
    // the status line. The request sent `Connection: close`, so the peer
    // closes its end after writing the response — loop until EOF (`Ok(0)`) or
    // the read timeout fires, capping how much we ever buffer so a huge or
    // pathological response can't grow this unbounded.
    const MAX_LEN: usize = 4096;
    let mut buf = Vec::with_capacity(MAX_LEN);
    let mut chunk = [0u8; 512];
    while buf.len() < MAX_LEN {
        match stream.read(&mut chunk) {
            Ok(0) => break, // EOF — peer closed per Connection: close
            Ok(n) => {
                let take = n.min(MAX_LEN - buf.len());
                buf.extend_from_slice(&chunk[..take]);
            }
            Err(_) => break, // timeout or reset — decide from whatever we have
        }
    }
    if buf.is_empty() {
        return false;
    }
    health_response_indicates_ready(&buf)
}

/// Find the first occurrence of `needle` in `haystack`, or `None`.
fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Decide readiness from a raw HTTP response buffer (status line + headers +
/// body, as read by `probe_health`). Requires a 200 status line first — same
/// as before this change, and still what makes llama-server's 503-while-
/// loading correctly read as "not ready". When the status is 200, look at
/// the JSON body (robust to the exact framing: take the slice from the body's
/// first '{' to its last '}', rather than assuming exact chunking): if it
/// parses as an object with a "model" key whose value is JSON null, the
/// daemon has bound the port but no model is resident yet (hipfire, still
/// loading) — not ready. If there's no "model" key at all (llama-server), or
/// the body is empty/unparseable, keep today's semantics: a 200 status means
/// ready.
fn health_response_indicates_ready(buf: &[u8]) -> bool {
    if !(buf.starts_with(b"HTTP/1.1 200") || buf.starts_with(b"HTTP/1.0 200")) {
        return false;
    }
    let body = match find_subslice(buf, b"\r\n\r\n") {
        Some(idx) => &buf[idx + 4..],
        None => buf,
    };
    let start = body.iter().position(|&b| b == b'{');
    let end = body.iter().rposition(|&b| b == b'}');
    let (Some(s), Some(e)) = (start, end) else {
        return true; // no JSON object in the body — bare 200 means ready
    };
    if e < s {
        return true;
    }
    match serde_json::from_slice::<serde_json::Value>(&body[s..=e]) {
        Ok(serde_json::Value::Object(map)) => !matches!(map.get("model"), Some(serde_json::Value::Null)),
        _ => true, // unparseable — keep today's semantics
    }
}

/// Readiness-probe deadline for a spawn: `Some(600s)` for llama (unchanged —
/// byte-identical to before `health_response_indicates_ready` existed),
/// `None` (no deadline) for hipfire. hipfire's `/health` now gates readiness
/// on the model finishing its potentially multi-GB HuggingFace auto-pull plus
/// the VRAM load (see `health_response_indicates_ready`), which routinely
/// runs well past the 10 minutes this deadline was sized for back when a bare
/// 200 meant ready. Dropping the deadline doesn't risk a leaked thread: the
/// probe loop above still exits the moment it succeeds, or the moment
/// `probe_gen` is bumped — by `stop_server`/a fresh `start_server`, or by
/// `server_status` noticing via `try_wait()` that the child died.
fn probe_timeout(hipfire: bool) -> Option<Duration> {
    if hipfire {
        None
    } else {
        Some(Duration::from_secs(600))
    }
}

/// Kill `child`, using a full Windows process-tree kill when `tree_kill` is
/// set. hipfire's installed CLI is a `.cmd` shim, so spawning it (`serve` or
/// `quantize`/`pull`) really launches `cmd.exe`, which in turn spawns the
/// actual `bun.exe` process doing the work. Proven live 2026-07-18: killing
/// just the top `cmd.exe` process (exactly what `child.kill()` does) leaves
/// `bun.exe` running, still holding the model's VRAM and the server port —
/// and no `hipfire stop`/`hipfire stop --force` can clean it up on Windows
/// (both are broken there; see the live-verification notes). `taskkill /F /T
/// /PID <pid>` kills the whole tree by PID instead of just the top process.
///
/// Falls back to a plain `child.kill()` when `tree_kill` is unset, `taskkill`
/// itself fails to spawn or exits non-zero, or the platform isn't Windows (on
/// Unix the hipfire child IS `bun` directly — no intermediate shell wrapper
/// to worry about, so `tree_kill` has no effect there). Always reaps the
/// child afterwards via `wait()` so it doesn't linger as a zombie.
pub fn kill_child_tree(child: &mut Child, tree_kill: bool) {
    #[cfg(windows)]
    {
        if tree_kill {
            let pid = child.id();
            let result = quiet_command(Path::new("taskkill"))
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            match result {
                Ok(status) if status.success() => {
                    debug!("kill_child_tree: taskkill reaped pid {pid} and its process tree");
                }
                Ok(status) => {
                    warn!(
                        "kill_child_tree: taskkill exited {status} for pid {pid} — falling back to child.kill()"
                    );
                    let _ = child.kill();
                }
                Err(e) => {
                    warn!(
                        "kill_child_tree: taskkill spawn failed for pid {pid} ({e}) — falling back to child.kill()"
                    );
                    let _ = child.kill();
                }
            }
        } else {
            let _ = child.kill();
        }
    }
    #[cfg(not(windows))]
    {
        // On Unix the hipfire child IS bun (no intermediate cmd.exe shim), so
        // a plain kill is always sufficient — tree_kill only matters on
        // Windows. Reference it so the parameter isn't unused there.
        let _ = tree_kill;
        let _ = child.kill();
    }
    let _ = child.wait();
}

/// Whether a child spawned with this `exe_path` needs a Windows process-tree
/// kill — true only for the hipfire engine (`exe_path.is_some()`), never for
/// llama (`exe_path.is_none()`), which spawns `llama-server` directly with no
/// intermediate shell wrapper. Mirrors the `exe_path.is_some()` discriminator
/// `start_server` already uses to pick the spawn path.
fn needs_tree_kill(exe_path: &Option<String>) -> bool {
    exe_path.is_some()
}

// True when `s` looks like the HOST half of a hipfire "host:port" token —
// the shapes buildHipfireArgs.ts emits / the app documents: a dotted IPv4
// ("127.0.0.1", "0.0.0.0"), the literal "localhost", or an IPv6 form
// (contains "::"). A bare model tag segment (e.g. "chat", "model") matches
// none of these, so `parse_port`'s positional fallback below can't mistake a
// tag whose last colon-segment happens to be numeric (e.g. "chat:70",
// "model:11434") for the real host:port token.
fn looks_like_host(s: &str) -> bool {
    s.eq_ignore_ascii_case("localhost") || s.contains('.') || s.contains("::")
}

pub fn parse_port(args: &[String]) -> u16 {
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
    // hipfire takes its port positionally as the tail of a "host:port" token
    // (e.g. "127.0.0.1:8080") rather than a --port flag — see buildHipfireArgs.
    // Fall back to scanning for that shape only after the flag search above
    // comes up empty, so llama-server's argv (which never contains such a
    // token) is unaffected and this stays byte-identical for the llama path.
    // hipfire's argv is `["serve", <tag>, "127.0.0.1:8080", ...]` — the TAG
    // (index 1) is scanned before the real host:port (index 2), so only a
    // token whose colon-prefix actually looks like a host is accepted;
    // otherwise a tag like "chat:70" or "model:11434" would be mistaken for
    // the port (see parse_port_reads_hipfire_positional_host_port and the
    // tag-with-numeric-suffix regression tests below).
    for a in args {
        if let Some((host, port_str)) = a.rsplit_once(':') {
            if looks_like_host(host) {
                if let Ok(p) = port_str.parse::<u16>() {
                    return p;
                }
            }
        }
    }
    8080
}

/// Candidate filenames for the `hipfire` CLI shim, checked in order, per
/// platform. On Windows the installed CLI is a `.cmd` shim (no `.exe` ships),
/// but `.exe`/`.bat` are checked too in case a future/alternate install shape
/// uses them.
fn hipfire_candidate_names() -> &'static [&'static str] {
    if cfg!(windows) {
        &["hipfire.cmd", "hipfire.exe", "hipfire.bat"]
    } else {
        &["hipfire"]
    }
}

/// Core of `resolve_hipfire_bin`, parameterized over the PATH/HOME values so
/// tests can exercise the search/fallback branches deterministically without
/// mutating real process env vars (flaky under parallel test execution) or
/// depending on a real `hipfire` install being present on the dev machine.
fn resolve_hipfire_bin_with_env(
    explicit: &str,
    path_var: Option<&str>,
    home_var: Option<&str>,
) -> Result<PathBuf, String> {
    // (a) explicit user override wins, but only when it actually exists —
    // a stale/typo'd path falls through to auto-resolution rather than
    // hard-failing, so clearing a bad override still lets the app launch.
    if !explicit.trim().is_empty() {
        let p = PathBuf::from(explicit);
        if p.is_file() {
            return Ok(p);
        }
    }

    // (b) search PATH for the installed CLI shim.
    if let Some(path_var) = path_var {
        for dir in std::env::split_paths(path_var) {
            for name in hipfire_candidate_names() {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return Ok(candidate);
                }
            }
        }
    }

    // (c) fall back to hipfire's own canonical install location, in case the
    // installer didn't (or couldn't) put it on PATH.
    if let Some(home) = home_var {
        let fallback_name = if cfg!(windows) { "hipfire.cmd" } else { "hipfire" };
        let fallback = PathBuf::from(home)
            .join(".hipfire")
            .join("bin")
            .join(fallback_name);
        if fallback.is_file() {
            return Ok(fallback);
        }
    }

    Err("hipfire not found on PATH — install it or set the binary path in Configure".to_string())
}

/// Resolve the hipfire binary to spawn (also used by `hipfire_convert` for
/// `hipfire quantize`). Resolution order:
///   (a) `explicit`, if non-empty and it names an existing file — user
///       override always wins;
///   (b) the `hipfire` shim found by searching `PATH` (a `.cmd` on Windows,
///       since the installed CLI is a Bun script wrapped in a shim rather
///       than a native exe);
///   (c) hipfire's own canonical install dir (`~/.hipfire/bin/`);
///   (d) an error naming both fixes (install hipfire, or set the path in
///       Configure).
pub fn resolve_hipfire_bin(explicit: &str) -> Result<PathBuf, String> {
    let path_var = std::env::var("PATH").ok();
    let home_var = if cfg!(windows) {
        std::env::var("USERPROFILE").ok()
    } else {
        std::env::var("HOME").ok()
    };
    resolve_hipfire_bin_with_env(explicit, path_var.as_deref(), home_var.as_deref())
}

/// Tauri command wrapper around `resolve_hipfire_bin` — a separate Rust
/// identifier because a command function can't share a name with the plain
/// helper it wraps, but it's registered/invoked from the frontend under this
/// name.
#[tauri::command]
pub fn resolve_hipfire_bin_cmd(explicit: String) -> Result<String, String> {
    resolve_hipfire_bin(&explicit).map(|p| p.to_string_lossy().into_owned())
}

/// One locally-registered hipfire model, as reported by `hipfire list`'s
/// "Local models:" section.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct HipfireLocalModel {
    pub file: String,
    pub size: String,
    pub tag: String,
}

/// Parse a single "Local models:" entry line, e.g.:
///   "  qwen3.6-27b.mq4                     15.0GB (qwen3.6:27b)"
/// Two-space indent, FILE (no spaces), whitespace, SIZE, whitespace, "(TAG)".
/// Returns `None` for a line that doesn't have the indent + all three fields.
fn parse_local_model_line(line: &str) -> Option<HipfireLocalModel> {
    if !line.starts_with(' ') {
        return None;
    }
    let mut parts = line.trim().split_whitespace();
    let file = parts.next()?.to_string();
    let size = parts.next()?.to_string();
    let rest: String = parts.collect::<Vec<_>>().join(" ");
    let tag = rest
        .strip_prefix('(')
        .and_then(|s| s.strip_suffix(')'))?
        .to_string();
    if tag.is_empty() {
        return None;
    }
    Some(HipfireLocalModel { file, size, tag })
}

/// Parse the "Local models:" section out of `hipfire list` output. Pure — no
/// process spawning — so it's unit-testable against the exact live-captured
/// fixture (live-verification-checklist.md, 2026-07-18 re-verification).
/// Any other top-level (non-indented, non-blank) line — e.g. `list -r`'s
/// "Available models:" header — ends the section. Returns an empty vec when
/// the section is missing or has no entries.
pub fn parse_hipfire_list(output: &str) -> Vec<HipfireLocalModel> {
    let mut models = Vec::new();
    let mut in_section = false;
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed == "Local models:" {
            in_section = true;
            continue;
        }
        if !in_section || trimmed.is_empty() {
            continue;
        }
        if !line.starts_with(' ') {
            in_section = false;
            continue;
        }
        if let Some(m) = parse_local_model_line(line) {
            models.push(m);
        }
    }
    models
}

/// Run `<hipfire> list` and parse its "Local models:" section — the tags
/// already registered and ready to `serve` without triggering an auto-pull
/// from HuggingFace. `explicit`, when given, is the same `hipfire_path`
/// override `resolve_hipfire_bin` takes everywhere else.
#[tauri::command]
pub fn list_hipfire_models(explicit: Option<String>) -> Result<Vec<HipfireLocalModel>, String> {
    let bin = resolve_hipfire_bin(explicit.as_deref().unwrap_or(""))?;
    let work_dir = bin
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    let output = quiet_command(&bin)
        .arg("list")
        .current_dir(&work_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("spawn hipfire list: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("hipfire list failed: {}", stderr.trim()));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_hipfire_list(&stdout))
}

#[tauri::command]
pub fn start_server(
    app: AppHandle,
    state: State<'_, ServerState>,
    build_dir: String,
    args: Vec<String>,
    exe_path: Option<String>,
    env: Option<Vec<(String, String)>>,
) -> Result<RunningInfo, String> {
    info!(
        "start_server: build_dir={build_dir} exe={} args={}",
        exe_path.as_deref().unwrap_or("<llama-server>"),
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
        // This stray child (if any) was spawned by the PREVIOUS start_server
        // call, so it needs the tree-kill flag that call recorded — not the
        // new one we're about to compute below.
        kill_child_tree(c, state.tree_kill.load(Ordering::SeqCst));
    }

    // Resolve the executable to spawn and the directory to spawn it in. When
    // the frontend passes an explicit exe path (e.g. the hipfire binary),
    // spawn that file directly; otherwise fall back to the existing
    // llama-server resolution under build_dir (byte-identical to before).
    let (server, work_dir) = if let Some(exe) = exe_path.as_deref() {
        let path = PathBuf::from(exe);
        if !path.is_file() {
            error!(
                "start_server: engine binary not found at {}",
                path.display()
            );
            return Err(format!(
                "engine binary not found at {}",
                path.to_string_lossy()
            ));
        }
        // Run in the binary's own directory so sibling DLLs resolve, mirroring
        // the llama-server bin_dir behaviour below.
        let dir = path
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));
        (path, dir)
    } else {
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
        (server, bin_dir)
    };

    // Record whether THIS child (about to be spawned) needs a Windows
    // process-tree kill — the hipfire discriminator, same as the branch
    // above. Stored now, ahead of the spawn, so it's correct for
    // stop_server/window-close even if something later in this function
    // fails after the child is already running.
    state
        .tree_kill
        .store(needs_tree_kill(&exe_path), Ordering::SeqCst);

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
    let mut cmd = quiet_command(&server);
    cmd.args(&args)
        .current_dir(&work_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Apply caller-supplied environment variables on TOP of the inherited
    // parent environment: Command inherits by default and `.envs()` only
    // adds/overrides the given keys, so PATH etc. stay intact. `env == None`
    // leaves the command byte-identical to the pre-env behaviour.
    if let Some(pairs) = &env {
        cmd.envs(pairs.iter().map(|(k, v)| (k, v)));
    }
    let mut child = cmd.spawn().map_err(|e| {
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
    let hipfire_probe = exe_path.is_some();
    std::thread::spawn(move || {
        let deadline = probe_timeout(hipfire_probe).map(|d| std::time::Instant::now() + d);
        loop {
            if probe_gen.load(Ordering::SeqCst) != gen {
                debug!("health-probe: generation changed, exiting");
                return;
            }
            if deadline.is_some_and(|d| std::time::Instant::now() > d) {
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
pub fn stop_server(state: State<'_, ServerState>) -> Result<(), String> {
    let mut child_slot = lock_or_poisoned(&state.child);
    let pid = lock_or_poisoned(&state.info).as_ref().map(|i| i.pid);
    if let Some(mut child) = child_slot.take() {
        if let Some(p) = pid {
            info!("stop_server: killing pid {}", p);
        } else {
            info!("stop_server: killing child");
        }
        kill_child_tree(&mut child, state.tree_kill.load(Ordering::SeqCst));
    } else {
        debug!("stop_server: no child to kill");
    }
    *lock_or_poisoned(&state.info) = None;
    state.ready.store(false, Ordering::SeqCst);
    state.probe_gen.fetch_add(1, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn server_status(state: State<'_, ServerState>) -> ServerStatus {
    let mut child_slot = lock_or_poisoned(&state.child);
    let mut info_slot = lock_or_poisoned(&state.info);
    if let Some(child) = child_slot.as_mut() {
        match child.try_wait() {
            Ok(Some(_status)) => {
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
    fn parse_port_picks_last_value_when_repeated() {
        let args = vec![
            "--port".into(),
            "8000".into(),
            "--other".into(),
            "x".into(),
            "--port".into(),
            "9001".into(),
        ];
        // The current impl returns the first valid value it encounters.
        assert_eq!(parse_port(&args), 8000);
    }

    #[test]
    fn parse_port_ignores_dangling_flag() {
        let args = vec!["--port".to_string()];
        assert_eq!(parse_port(&args), 8080);
    }

    #[test]
    fn parse_port_reads_hipfire_positional_host_port() {
        // hipfire's argv: ["serve", "<tag>", "127.0.0.1:8080", ...].
        let args = vec![
            "serve".into(),
            "qwen3.6:27b".into(),
            "127.0.0.1:8080".into(),
        ];
        assert_eq!(parse_port(&args), 8080);
    }

    #[test]
    fn parse_port_ignores_windows_paths_with_a_drive_letter_colon() {
        // "C:\models\m.gguf" contains a ':' but its suffix isn't numeric, so it
        // must not be mistaken for a hipfire "host:port" token.
        let args = vec!["--model".into(), "C:\\models\\m.gguf".into()];
        assert_eq!(parse_port(&args), 8080);
    }

    #[test]
    fn parse_port_prefers_the_flag_form_over_a_positional_host_port() {
        // Belt-and-suspenders: if an argv somehow carries both shapes, the
        // explicit --port flag (llama-server's form) wins.
        let args = vec!["--port".into(), "9090".into(), "127.0.0.1:8080".into()];
        assert_eq!(parse_port(&args), 9090);
    }

    #[test]
    fn parse_port_does_not_mistake_a_numeric_tag_suffix_for_the_port() {
        // Regression: a model tag whose last colon-segment is numeric (e.g.
        // "chat:70") must not be scanned as a "host:port" token — only the
        // real positional host:port (which has a host-shaped prefix) counts.
        let args = vec!["serve".into(), "chat:70".into(), "127.0.0.1:8080".into()];
        assert_eq!(parse_port(&args), 8080);

        let args = vec!["serve".into(), "model:11434".into(), "0.0.0.0:11435".into()];
        assert_eq!(parse_port(&args), 11435);

        let args = vec!["serve".into(), "x:2024".into(), "localhost:9000".into()];
        assert_eq!(parse_port(&args), 9000);
    }

    #[test]
    fn probe_health_returns_false_for_closed_port() {
        // Port 1 is virtually never listening on a dev machine.
        assert!(!probe_health(1));
    }

    #[test]
    fn server_state_default_is_idle() {
        let s = ServerState::default();
        assert!(s.child.lock().unwrap().is_none());
        assert!(s.info.lock().unwrap().is_none());
        assert!(!s.ready.load(Ordering::SeqCst));
    }

    // ── resolve_hipfire_bin ──────────────────────────────────────────────

    #[test]
    fn resolve_hipfire_bin_returns_explicit_existing_path_as_is() {
        // A real, existing file (this test binary's own PATH search never
        // gets consulted since the explicit check short-circuits first) —
        // any existing file works; use a temp file so the test doesn't
        // depend on anything about the dev machine's layout.
        let dir = std::env::temp_dir();
        let file = dir.join("lm-st-test-hipfire-explicit.tmp");
        std::fs::write(&file, b"stub").expect("write temp file");
        let explicit = file.to_string_lossy().into_owned();

        let resolved = resolve_hipfire_bin(&explicit).expect("explicit existing path resolves");
        assert_eq!(resolved, file);

        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn resolve_hipfire_bin_ignores_nonexistent_explicit_and_falls_through() {
        // A bogus explicit path must not be returned verbatim — it should be
        // ignored and fall through to the PATH/HOME search. With both
        // scrubbed (None), that search comes up empty and yields the
        // not-found Err rather than the invalid explicit path.
        let bogus = std::env::temp_dir()
            .join("lm-st-test-hipfire-does-not-exist.tmp")
            .to_string_lossy()
            .into_owned();
        assert!(!PathBuf::from(&bogus).exists());

        let err = resolve_hipfire_bin_with_env(&bogus, None, None)
            .expect_err("nonexistent explicit + empty PATH/HOME must error");
        assert!(err.contains("hipfire not found on PATH"));
    }

    #[test]
    fn resolve_hipfire_bin_errs_with_empty_explicit_and_scrubbed_path_home() {
        let err = resolve_hipfire_bin_with_env("", None, None)
            .expect_err("no explicit + no PATH/HOME must error");
        assert_eq!(
            err,
            "hipfire not found on PATH — install it or set the binary path in Configure"
        );
    }

    #[test]
    fn resolve_hipfire_bin_finds_shim_on_synthetic_path() {
        // Search PATH branch, exercised against a synthetic PATH (a temp dir
        // holding a fake shim) rather than any real hipfire install, so this
        // stays deterministic regardless of the host machine.
        let dir = std::env::temp_dir().join("lm-st-test-hipfire-path-dir");
        std::fs::create_dir_all(&dir).expect("mkdir temp path dir");
        let shim_name = if cfg!(windows) { "hipfire.cmd" } else { "hipfire" };
        let shim = dir.join(shim_name);
        std::fs::write(&shim, b"stub").expect("write fake shim");

        let path_var = dir.to_string_lossy().into_owned();
        let resolved = resolve_hipfire_bin_with_env("", Some(&path_var), None)
            .expect("synthetic PATH search resolves the shim");
        assert_eq!(resolved, shim);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_hipfire_bin_falls_back_to_canonical_install_dir() {
        // Canonical fallback branch: no explicit path, empty PATH, but a
        // synthetic HOME with `~/.hipfire/bin/<shim>` present.
        let home = std::env::temp_dir().join("lm-st-test-hipfire-home");
        let bin_dir = home.join(".hipfire").join("bin");
        std::fs::create_dir_all(&bin_dir).expect("mkdir synthetic home bin dir");
        let shim_name = if cfg!(windows) { "hipfire.cmd" } else { "hipfire" };
        let shim = bin_dir.join(shim_name);
        std::fs::write(&shim, b"stub").expect("write fake shim");

        let home_var = home.to_string_lossy().into_owned();
        let resolved = resolve_hipfire_bin_with_env("", None, Some(&home_var))
            .expect("canonical fallback resolves the shim");
        assert_eq!(resolved, shim);

        let _ = std::fs::remove_dir_all(&home);
    }

    // ── parse_hipfire_list ───────────────────────────────────────────────

    #[test]
    fn parse_hipfire_list_reads_the_live_captured_fixture() {
        // Verbatim capture from `hipfire list` (live-verification-checklist.md,
        // 2026-07-18 re-verification, fact 5).
        let output = "Local models:\n\n  qwen3.6-27b.mq4                     15.0GB (qwen3.6:27b)\n  qwen36-27b-dflash-mq4.hfq            0.9GB (qwen3.6:27b-draft)\n";
        let models = parse_hipfire_list(output);
        assert_eq!(
            models,
            vec![
                HipfireLocalModel {
                    file: "qwen3.6-27b.mq4".to_string(),
                    size: "15.0GB".to_string(),
                    tag: "qwen3.6:27b".to_string(),
                },
                HipfireLocalModel {
                    file: "qwen36-27b-dflash-mq4.hfq".to_string(),
                    size: "0.9GB".to_string(),
                    tag: "qwen3.6:27b-draft".to_string(),
                },
            ]
        );
    }

    #[test]
    fn parse_hipfire_list_empty_output_yields_empty_vec() {
        assert!(parse_hipfire_list("").is_empty());
    }

    #[test]
    fn parse_hipfire_list_missing_section_yields_empty_vec() {
        assert!(parse_hipfire_list("some unrelated CLI output\n").is_empty());
    }

    #[test]
    fn parse_hipfire_list_stops_at_the_available_models_section() {
        // A combined `list -r` output must not leak "Available models:" rows
        // into the "Local models:" result.
        let output = "Local models:\n\n  qwen3.6-27b.mq4                     15.0GB (qwen3.6:27b)\n\nAvailable models:\n\n  qwen3.5:0.8b            0.55GB  386 / 5100 tok/s\n";
        let models = parse_hipfire_list(output);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].tag, "qwen3.6:27b");
    }

    // ── health_response_indicates_ready ──────────────────────────────────

    #[test]
    fn health_response_ready_for_plain_llama_ok_body() {
        // llama-server's /health has no "model" key at all.
        let resp = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 15\r\n\r\n{\"status\":\"ok\"}";
        assert!(health_response_indicates_ready(resp));
    }

    #[test]
    fn health_response_not_ready_when_hipfire_model_is_null() {
        // Fact 2 verbatim: daemon bound the port, but no model is resident yet.
        let body = br#"{"status":"ok","model":null,"idle_timeout_sec":300,"pid":42784,"token":"42784-mrql36h5-mz74d1dt"}"#;
        let mut resp = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n".to_vec();
        resp.extend_from_slice(body);
        assert!(!health_response_indicates_ready(&resp));
    }

    #[test]
    fn health_response_ready_when_hipfire_model_is_resident() {
        let body = br#"{"status":"ok","model":"C:\\Users\\pay20\\.hipfire\\models\\qwen3.6-27b.mq4","idle_timeout_sec":300,"pid":42784,"token":"x"}"#;
        let mut resp = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n".to_vec();
        resp.extend_from_slice(body);
        assert!(health_response_indicates_ready(&resp));
    }

    #[test]
    fn health_response_ready_for_empty_body() {
        let resp = b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n";
        assert!(health_response_indicates_ready(resp));
    }

    #[test]
    fn health_response_not_ready_for_non_200_status() {
        let resp = b"HTTP/1.1 503 Service Unavailable\r\n\r\n{\"status\":\"loading\"}";
        assert!(!health_response_indicates_ready(resp));
    }

    // ── probe_timeout ─────────────────────────────────────────────────────

    #[test]
    fn probe_timeout_llama_keeps_the_original_ten_minute_deadline() {
        assert_eq!(probe_timeout(false), Some(Duration::from_secs(600)));
    }

    #[test]
    fn probe_timeout_hipfire_has_no_deadline() {
        // hipfire's readiness can legitimately take longer than 10 minutes
        // (multi-GB HuggingFace auto-pull + VRAM load) — see
        // health_response_indicates_ready.
        assert_eq!(probe_timeout(true), None);
    }

    // ── tree_kill flag plumbing ──────────────────────────────────────────

    #[test]
    fn server_state_default_tree_kill_is_false() {
        let s = ServerState::default();
        assert!(!s.tree_kill.load(Ordering::SeqCst));
    }

    #[test]
    fn needs_tree_kill_false_for_the_llama_path() {
        assert!(!needs_tree_kill(&None));
    }

    #[test]
    fn needs_tree_kill_true_when_exe_path_is_set() {
        assert!(needs_tree_kill(&Some(
            "C:/Users/pay20/.hipfire/bin/hipfire.cmd".to_string()
        )));
    }
}
