// Minimal MCP (Model Context Protocol) client.
//
// Supports two transports:
//   - "stdio": spawn a child process, exchange JSON-RPC 2.0 over stdin/stdout
//   - "http":  POST JSON-RPC bodies to a URL; if the server replies with
//              `text/event-stream` we parse the first JSON-RPC frame out of it
//              (this covers both legacy "HTTP+SSE" responses and the modern
//              "Streamable HTTP" transport when no follow-up notifications are
//              needed for a single tool/list or tools/call).
//
// We only implement what the chat loop needs today: `initialize`, `tools/list`,
// `tools/call`. Notifications from the server are read off the stdio pipe so
// they don't wedge the request lane, but we don't surface them yet.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    mpsc::{channel, Receiver, RecvTimeoutError, Sender},
    Arc, Mutex,
};
use std::thread;
use std::time::Duration;

use log::{debug, error, info, warn};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// User-configured MCP server. Persisted to settings.json.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    pub id: String,
    pub name: String,
    /// One of: "stdio", "http", "sse" (sse routes through the http transport too)
    pub transport: String,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub autostart: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct McpTool {
    pub name: String,
    pub description: Option<String>,
    pub input_schema: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct McpStatus {
    pub id: String,
    pub connected: bool,
    pub error: Option<String>,
    pub tool_count: usize,
    pub server_name: Option<String>,
}

/// On Windows, `Command::new("foo")` goes through `CreateProcessW`, which only
/// appends `.exe` when searching PATH — npm-style `foo.cmd` shims that work in
/// a shell are never found and spawn fails with "program not found". Resolve
/// PATH + PATHEXT the way a shell would; returning the extension-qualified
/// path also lets std route `.cmd`/`.bat` files through cmd.exe safely.
#[cfg(windows)]
fn resolve_program(program: &str) -> std::ffi::OsString {
    use std::path::{Path, PathBuf};

    let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    let exts: Vec<&str> = pathext.split(';').filter(|e| !e.is_empty()).collect();

    // Try the path as given, then with each PATHEXT extension appended.
    let try_exts = |stem: &Path| -> Option<PathBuf> {
        if stem.is_file() {
            return Some(stem.to_path_buf());
        }
        exts.iter()
            .map(|ext| {
                let mut s = stem.as_os_str().to_os_string();
                s.push(ext);
                PathBuf::from(s)
            })
            .find(|candidate| candidate.is_file())
    };

    let resolved = if program.contains(['\\', '/']) {
        try_exts(Path::new(program))
    } else {
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .find_map(|dir| try_exts(&dir.join(program)))
    };
    resolved.map_or_else(|| program.into(), PathBuf::into_os_string)
}

#[cfg(not(windows))]
fn resolve_program(program: &str) -> std::ffi::OsString {
    program.into()
}

/// Users paste `serve --mcp` as a single "argument" line; passing that to the
/// child as one argv entry makes CLIs bail with `unknown command 'serve --mcp'`.
/// Split each configured arg on whitespace the way a shell would, honoring
/// double quotes so args with spaces (paths) stay intact.
fn split_arg_line(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    for c in line.chars() {
        match c {
            '"' => in_quotes = !in_quotes,
            c if c.is_whitespace() && !in_quotes => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Active connection handle. Behind a Mutex inside the registry.
struct McpClient {
    transport: Transport,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, Sender<Value>>>,
    /// Cached tool list — refreshed on connect and on explicit reload.
    tools: Mutex<Vec<McpTool>>,
    /// Server-advertised name from `initialize` response.
    server_name: Mutex<Option<String>>,
    last_error: Mutex<Option<String>>,
    /// False once the stdio child's stdout closes — requests fail immediately
    /// instead of riding out the full response timeout. Always true for http.
    alive: AtomicBool,
    /// Last few stderr lines from the stdio child, surfaced in errors so a
    /// dying server explains itself (e.g. `unknown command 'serve --mcp'`).
    stderr_tail: Mutex<VecDeque<String>>,
}

enum Transport {
    Stdio {
        stdin: Mutex<ChildStdin>,
        child: Mutex<Child>,
    },
    Http {
        url: String,
        headers: HashMap<String, String>,
    },
}

impl McpClient {
    /// Open a transport. For stdio, spawns the process and starts a reader
    /// thread that demuxes responses back to per-request channels. For http
    /// there's no persistent state — the client just remembers the URL.
    fn connect(cfg: &McpServerConfig) -> Result<Arc<Self>, String> {
        match cfg.transport.as_str() {
            "stdio" => Self::connect_stdio(cfg),
            "http" | "sse" => Self::connect_http(cfg),
            other => Err(format!("unknown MCP transport: {other}")),
        }
    }

    fn connect_stdio(cfg: &McpServerConfig) -> Result<Arc<Self>, String> {
        let command = cfg
            .command
            .as_ref()
            .ok_or_else(|| "stdio MCP server is missing `command`".to_string())?;

        let args: Vec<String> = cfg.args.iter().flat_map(|a| split_arg_line(a)).collect();
        let mut cmd = Command::new(resolve_program(command));
        cmd.args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(cwd) = &cfg.cwd {
            cmd.current_dir(cwd);
        }
        for (k, v) in &cfg.env {
            cmd.env(k, v);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("spawn `{command}` failed: {e}"))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "child stdin missing".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "child stdout missing".to_string())?;
        let stderr = child.stderr.take();

        let client = Arc::new(McpClient {
            transport: Transport::Stdio {
                stdin: Mutex::new(stdin),
                child: Mutex::new(child),
            },
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            tools: Mutex::new(Vec::new()),
            server_name: Mutex::new(None),
            last_error: Mutex::new(None),
            alive: AtomicBool::new(true),
            stderr_tail: Mutex::new(VecDeque::new()),
        });

        // Reader thread: parse newline-delimited JSON-RPC frames from stdout
        // and route to the matching pending sender by id.
        {
            let client = client.clone();
            let server_id = cfg.id.clone();
            thread::spawn(move || {
                let buf = BufReader::new(stdout);
                for line in buf.lines() {
                    let line = match line {
                        Ok(l) => l,
                        Err(e) => {
                            warn!("mcp[{server_id}] stdout read error: {e}");
                            break;
                        }
                    };
                    if line.trim().is_empty() {
                        continue;
                    }
                    let parsed: Value = match serde_json::from_str(&line) {
                        Ok(v) => v,
                        Err(e) => {
                            warn!("mcp[{server_id}] non-JSON line dropped: {e}: {line}");
                            continue;
                        }
                    };
                    if let Some(id) = parsed.get("id").and_then(|v| v.as_u64()) {
                        let sender = client.pending.lock().ok().and_then(|mut m| m.remove(&id));
                        if let Some(tx) = sender {
                            let _ = tx.send(parsed);
                        } else {
                            debug!("mcp[{server_id}] orphan response id={id}");
                        }
                    } else if parsed.get("method").is_some() {
                        debug!("mcp[{server_id}] notification: {line}");
                    } else {
                        debug!("mcp[{server_id}] unmatched frame: {line}");
                    }
                }
                warn!("mcp[{server_id}] stdout closed — server process gone");
                // Wake every in-flight request now; dropping the senders makes
                // their receivers see Disconnected instead of a 60s timeout.
                client.alive.store(false, Ordering::Release);
                if let Ok(mut p) = client.pending.lock() {
                    p.clear();
                }
            });
        }
        if let Some(stderr) = stderr {
            let server_id = cfg.id.clone();
            let client = client.clone();
            thread::spawn(move || {
                let buf = BufReader::new(stderr);
                for line in buf.lines().map_while(Result::ok) {
                    if !line.trim().is_empty() {
                        debug!("mcp[{server_id}] stderr: {line}");
                        if let Ok(mut tail) = client.stderr_tail.lock() {
                            if tail.len() >= 5 {
                                tail.pop_front();
                            }
                            tail.push_back(line);
                        }
                    }
                }
            });
        }

        if let Err(e) = client
            .initialize()
            .and_then(|()| client.reload_tools().map(|_| ()))
        {
            // Don't leak the child: a server that spoke garbage (or is hung)
            // would otherwise stay alive with no handle left to stop it.
            client.shutdown();
            return Err(e);
        }
        Ok(client)
    }

    fn connect_http(cfg: &McpServerConfig) -> Result<Arc<Self>, String> {
        let url = cfg
            .url
            .clone()
            .ok_or_else(|| "http MCP server is missing `url`".to_string())?;
        let client = Arc::new(McpClient {
            transport: Transport::Http {
                url,
                headers: cfg.headers.clone(),
            },
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            tools: Mutex::new(Vec::new()),
            server_name: Mutex::new(None),
            last_error: Mutex::new(None),
            alive: AtomicBool::new(true),
            stderr_tail: Mutex::new(VecDeque::new()),
        });
        client.initialize()?;
        client.reload_tools()?;
        Ok(client)
    }

    fn initialize(&self) -> Result<(), String> {
        let resp = self.request(
            "initialize",
            json!({
                "protocolVersion": "2025-03-26",
                "capabilities": { "tools": {} },
                "clientInfo": { "name": "llllllllammmmmmaaaaaaui", "version": "0.4.2" },
            }),
        )?;
        if let Some(name) = resp
            .get("serverInfo")
            .and_then(|s| s.get("name"))
            .and_then(|n| n.as_str())
        {
            *self.server_name.lock().unwrap() = Some(name.to_string());
        }
        // Some servers expect an "initialized" notification before further use.
        let _ = self.notify("notifications/initialized", json!({}));
        Ok(())
    }

    fn reload_tools(&self) -> Result<Vec<McpTool>, String> {
        let resp = self.request("tools/list", json!({}))?;
        let tools = resp
            .get("tools")
            .and_then(|t| t.as_array())
            .cloned()
            .unwrap_or_default();
        let parsed: Vec<McpTool> = tools
            .into_iter()
            .filter_map(|t| {
                let name = t.get("name")?.as_str()?.to_string();
                let description = t
                    .get("description")
                    .and_then(|d| d.as_str())
                    .map(|s| s.to_string());
                let input_schema = t
                    .get("inputSchema")
                    .cloned()
                    .unwrap_or_else(|| json!({ "type": "object" }));
                Some(McpTool {
                    name,
                    description,
                    input_schema,
                })
            })
            .collect();
        *self.tools.lock().unwrap() = parsed.clone();
        Ok(parsed)
    }

    pub fn call_tool(&self, name: &str, arguments: Value) -> Result<Value, String> {
        let resp = self.request(
            "tools/call",
            json!({ "name": name, "arguments": arguments }),
        )?;
        Ok(resp)
    }

    /// JSON-RPC request. Blocks the calling thread until a response arrives or
    /// the transport times out.
    fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let body = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        match &self.transport {
            Transport::Stdio { stdin, .. } => {
                if !self.alive.load(Ordering::Acquire) {
                    return Err(format!(
                        "{method}: server process is not running{}",
                        self.stderr_context()
                    ));
                }
                let (tx, rx) = channel::<Value>();
                self.pending.lock().unwrap().insert(id, tx);
                let serialized =
                    serde_json::to_string(&body).map_err(|e| format!("encode JSON-RPC: {e}"))?;
                let written = {
                    let mut w = stdin.lock().unwrap();
                    w.write_all(serialized.as_bytes())
                        .and_then(|_| w.write_all(b"\n"))
                        .and_then(|_| w.flush())
                };
                if let Err(e) = written {
                    if let Ok(mut p) = self.pending.lock() {
                        p.remove(&id);
                    }
                    return Err(format!("write stdin: {e}{}", self.stderr_context()));
                }
                self.wait_stdio_response(method, &rx, id)
            }
            Transport::Http { url, headers } => {
                let req = ureq::post(url)
                    .timeout(Duration::from_secs(60))
                    .set("Content-Type", "application/json")
                    .set("Accept", "application/json, text/event-stream");
                let req = headers
                    .iter()
                    .fold(req, |r, (k, v)| r.set(k.as_str(), v.as_str()));
                let serialized =
                    serde_json::to_string(&body).map_err(|e| format!("encode JSON-RPC: {e}"))?;
                let resp = req
                    .send_string(&serialized)
                    .map_err(|e| format!("http {method}: {e}"))?;
                let content_type = resp
                    .header("content-type")
                    .unwrap_or("application/json")
                    .to_string();
                let text = resp
                    .into_string()
                    .map_err(|e| format!("read http body: {e}"))?;
                parse_http_response(&content_type, &text, id, method)
            }
        }
    }

    fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        let body = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        match &self.transport {
            Transport::Stdio { stdin, .. } => {
                let serialized =
                    serde_json::to_string(&body).map_err(|e| format!("encode notify: {e}"))?;
                let mut w = stdin.lock().unwrap();
                w.write_all(serialized.as_bytes())
                    .and_then(|_| w.write_all(b"\n"))
                    .map_err(|e| format!("write notify: {e}"))?;
                w.flush().map_err(|e| format!("flush notify: {e}"))?;
            }
            Transport::Http { url, headers } => {
                let req = ureq::post(url)
                    .timeout(Duration::from_secs(10))
                    .set("Content-Type", "application/json")
                    .set("Accept", "application/json, text/event-stream");
                let req = headers
                    .iter()
                    .fold(req, |r, (k, v)| r.set(k.as_str(), v.as_str()));
                let serialized =
                    serde_json::to_string(&body).map_err(|e| format!("encode notify: {e}"))?;
                // Notifications don't require a body; ignore the response.
                let _ = req.send_string(&serialized);
            }
        }
        Ok(())
    }

    /// Block until the demux thread routes the response, the transport dies,
    /// or the timeout passes. A dead child fails immediately (the stdout pump
    /// drops every pending sender) rather than eating the whole timeout.
    fn wait_stdio_response(
        &self,
        method: &str,
        rx: &Receiver<Value>,
        id: u64,
    ) -> Result<Value, String> {
        match rx.recv_timeout(Duration::from_secs(60)) {
            Ok(resp) => extract_result(method, resp),
            Err(RecvTimeoutError::Disconnected) => {
                // Give the stderr pump a beat to drain the child's last words
                // so the error can say *why* it died.
                thread::sleep(Duration::from_millis(150));
                Err(format!(
                    "{method}: server process exited before responding{}",
                    self.stderr_context()
                ))
            }
            Err(RecvTimeoutError::Timeout) => {
                // Drop the pending sender if we time out so a late response
                // doesn't leak the slot forever.
                if let Ok(mut p) = self.pending.lock() {
                    p.remove(&id);
                }
                Err(format!("{method}: timed out after 60s"))
            }
        }
    }

    /// Recent child stderr formatted for appending to an error message.
    fn stderr_context(&self) -> String {
        let tail = match self.stderr_tail.lock() {
            Ok(t) if !t.is_empty() => t.iter().cloned().collect::<Vec<_>>().join(" | "),
            _ => return String::new(),
        };
        format!(" — stderr: {tail}")
    }

    fn shutdown(&self) {
        if let Transport::Stdio { child, .. } = &self.transport {
            if let Ok(mut c) = child.lock() {
                let _ = c.kill();
                let _ = c.wait();
            }
        }
    }
}

fn extract_result(method: &str, resp: Value) -> Result<Value, String> {
    if let Some(err) = resp.get("error") {
        let msg = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("unknown error");
        let code = err.get("code").and_then(|c| c.as_i64()).unwrap_or(0);
        return Err(format!("{method}: {msg} (code {code})"));
    }
    Ok(resp.get("result").cloned().unwrap_or(Value::Null))
}

fn parse_http_response(
    content_type: &str,
    body: &str,
    id: u64,
    method: &str,
) -> Result<Value, String> {
    if content_type.starts_with("text/event-stream") {
        // Scan SSE frames for the first `data:` line that JSON-parses and has
        // a matching id. Ignores keep-alives and unrelated frames.
        for frame in body.split("\n\n") {
            for line in frame.lines() {
                let line = line.trim_start();
                let Some(payload) = line.strip_prefix("data:") else {
                    continue;
                };
                let payload = payload.trim();
                if payload.is_empty() || payload == "[DONE]" {
                    continue;
                }
                if let Ok(v) = serde_json::from_str::<Value>(payload) {
                    let resp_id = v.get("id").and_then(|i| i.as_u64()).unwrap_or(0);
                    if resp_id == id || v.get("result").is_some() || v.get("error").is_some() {
                        return extract_result(method, v);
                    }
                }
            }
        }
        Err(format!("{method}: no matching SSE response frame"))
    } else {
        let v: Value =
            serde_json::from_str(body).map_err(|e| format!("decode JSON body: {e}: {body}"))?;
        extract_result(method, v)
    }
}

// ── Registry ────────────────────────────────────────────────────────────────
#[derive(Default)]
pub struct McpRegistry {
    clients: Mutex<HashMap<String, Arc<McpClient>>>,
    errors: Mutex<HashMap<String, String>>,
}

impl McpRegistry {
    pub fn connect(&self, cfg: &McpServerConfig) -> Result<McpStatus, String> {
        // Replace any existing connection cleanly.
        self.disconnect(&cfg.id);
        let client = McpClient::connect(cfg).map_err(|e| {
            self.errors
                .lock()
                .unwrap()
                .insert(cfg.id.clone(), e.clone());
            error!("mcp[{}] connect failed: {}", cfg.id, e);
            e
        })?;
        info!(
            "mcp[{}] connected ({} tools)",
            cfg.id,
            client.tools.lock().unwrap().len()
        );
        self.errors.lock().unwrap().remove(&cfg.id);
        let status = McpStatus {
            id: cfg.id.clone(),
            connected: true,
            error: None,
            tool_count: client.tools.lock().unwrap().len(),
            server_name: client.server_name.lock().unwrap().clone(),
        };
        self.clients.lock().unwrap().insert(cfg.id.clone(), client);
        Ok(status)
    }

    pub fn disconnect(&self, id: &str) {
        if let Some(c) = self.clients.lock().unwrap().remove(id) {
            c.shutdown();
            info!("mcp[{id}] disconnected");
        }
    }

    pub fn list_tools(&self, id: &str) -> Result<Vec<McpTool>, String> {
        let client = self
            .clients
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| format!("mcp[{id}] not connected"))?;
        let tools = client.tools.lock().unwrap().clone();
        Ok(tools)
    }

    pub fn call_tool(&self, id: &str, name: &str, arguments: Value) -> Result<Value, String> {
        let client = self
            .clients
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| format!("mcp[{id}] not connected"))?;
        client.call_tool(name, arguments).inspect_err(|e| {
            *client.last_error.lock().unwrap() = Some(e.clone());
        })
    }

    pub fn status_all(&self, configs: &[McpServerConfig]) -> Vec<McpStatus> {
        let clients = self.clients.lock().unwrap();
        let errors = self.errors.lock().unwrap();
        configs
            .iter()
            .map(|cfg| {
                if let Some(c) = clients.get(&cfg.id) {
                    McpStatus {
                        id: cfg.id.clone(),
                        connected: true,
                        error: c.last_error.lock().unwrap().clone(),
                        tool_count: c.tools.lock().unwrap().len(),
                        server_name: c.server_name.lock().unwrap().clone(),
                    }
                } else {
                    McpStatus {
                        id: cfg.id.clone(),
                        connected: false,
                        error: errors.get(&cfg.id).cloned(),
                        tool_count: 0,
                        server_name: None,
                    }
                }
            })
            .collect()
    }

    pub fn shutdown_all(&self) {
        let mut clients = self.clients.lock().unwrap();
        for (_, c) in clients.drain() {
            c.shutdown();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn resolve_program_finds_cmd_shim() {
        let dir = std::env::temp_dir().join("lm-st-resolve-program-test");
        std::fs::create_dir_all(&dir).unwrap();
        let shim = dir.join("fake-tool.cmd");
        std::fs::write(&shim, "@echo off\r\n").unwrap();

        // A path without extension resolves to the .cmd next to it. The
        // extension comes back in PATHEXT's casing (usually ".CMD"), which
        // both NTFS and std's batch-file detection treat case-insensitively.
        let resolved = resolve_program(dir.join("fake-tool").to_str().unwrap());
        assert_eq!(
            resolved.to_string_lossy().to_lowercase(),
            shim.to_string_lossy().to_lowercase()
        );

        // Unresolvable names pass through unchanged so spawn reports them.
        assert_eq!(
            resolve_program("definitely-not-a-real-program"),
            std::ffi::OsString::from("definitely-not-a-real-program")
        );
    }

    #[test]
    fn split_arg_line_splits_on_whitespace() {
        assert_eq!(split_arg_line("serve --mcp"), vec!["serve", "--mcp"]);
        assert_eq!(split_arg_line("  serve   --mcp  "), vec!["serve", "--mcp"]);
        assert_eq!(split_arg_line("--mcp"), vec!["--mcp"]);
        assert!(split_arg_line("   ").is_empty());
    }

    #[test]
    fn split_arg_line_quotes_keep_spaces() {
        assert_eq!(
            split_arg_line(r#"--dir "C:\Program Files\x" -v"#),
            vec!["--dir", r"C:\Program Files\x", "-v"]
        );
    }

    /// A child that exits without ever speaking MCP must fail the connect
    /// quickly with a process-exited error — not block for the full 60s
    /// response timeout (which, from a sync command, froze the whole UI).
    #[cfg(windows)]
    #[test]
    fn connect_fails_fast_when_child_exits() {
        let cfg = McpServerConfig {
            id: "dead".into(),
            name: "dead".into(),
            transport: "stdio".into(),
            command: Some("cmd".into()),
            args: vec!["/c exit 1".into()],
            env: HashMap::new(),
            cwd: None,
            url: None,
            headers: HashMap::new(),
            enabled: true,
            autostart: false,
        };
        let t0 = std::time::Instant::now();
        let err = McpClient::connect(&cfg).err().expect("connect must fail");
        assert!(
            t0.elapsed() < Duration::from_secs(10),
            "took {:?}",
            t0.elapsed()
        );
        assert!(err.contains("exited"), "unexpected error: {err}");
    }

    #[test]
    fn parse_sse_extracts_matching_frame() {
        let body =
            "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"ok\":true}}\n\n";
        let v = parse_http_response("text/event-stream", body, 7, "tools/call").unwrap();
        assert_eq!(v.get("ok"), Some(&Value::Bool(true)));
    }

    #[test]
    fn parse_json_response_returns_result() {
        let body = r#"{"jsonrpc":"2.0","id":1,"result":{"hello":"world"}}"#;
        let v = parse_http_response("application/json", body, 1, "initialize").unwrap();
        assert_eq!(v.get("hello").and_then(|s| s.as_str()), Some("world"));
    }

    #[test]
    fn extract_result_surfaces_error() {
        let v = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "error": { "code": -32601, "message": "Method not found" }
        });
        let err = extract_result("tools/list", v).unwrap_err();
        assert!(err.contains("Method not found"));
        assert!(err.contains("-32601"));
    }
}
