use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::path::PathBuf;
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
}

impl ServerState {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
            info: Mutex::new(None),
            ready: Arc::new(AtomicBool::new(false)),
            probe_gen: Arc::new(AtomicU64::new(0)),
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

/// Single-shot probe: TCP connect + raw GET /health, parse the status line.
/// Returns true if llama-server replied 200; false for any failure (refused,
/// 503 Loading model, read timeout, etc.).
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
        let _ = c.kill();
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
pub fn stop_server(state: State<'_, ServerState>) -> Result<(), String> {
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
}
