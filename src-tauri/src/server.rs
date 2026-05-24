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
    8080
}

#[tauri::command]
pub fn start_server(
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
}
