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

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    mpsc::{channel, Receiver, Sender},
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

        let mut cmd = Command::new(command);
        cmd.args(&cfg.args)
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
                debug!("mcp[{server_id}] stdout pump exited");
            });
        }
        if let Some(stderr) = stderr {
            let server_id = cfg.id.clone();
            thread::spawn(move || {
                let buf = BufReader::new(stderr);
                for line in buf.lines().map_while(Result::ok) {
                    if !line.trim().is_empty() {
                        debug!("mcp[{server_id}] stderr: {line}");
                    }
                }
            });
        }

        client.initialize()?;
        client.reload_tools()?;
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
                let (tx, rx) = channel::<Value>();
                self.pending.lock().unwrap().insert(id, tx);
                let serialized =
                    serde_json::to_string(&body).map_err(|e| format!("encode JSON-RPC: {e}"))?;
                {
                    let mut w = stdin.lock().unwrap();
                    w.write_all(serialized.as_bytes())
                        .and_then(|_| w.write_all(b"\n"))
                        .map_err(|e| format!("write stdin: {e}"))?;
                    w.flush().map_err(|e| format!("flush stdin: {e}"))?;
                }
                wait_for_response(method, &rx, &self.pending, id)
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

    fn shutdown(&self) {
        if let Transport::Stdio { child, .. } = &self.transport {
            if let Ok(mut c) = child.lock() {
                let _ = c.kill();
                let _ = c.wait();
            }
        }
    }
}

fn wait_for_response(
    method: &str,
    rx: &Receiver<Value>,
    pending: &Mutex<HashMap<u64, Sender<Value>>>,
    id: u64,
) -> Result<Value, String> {
    let resp = rx.recv_timeout(Duration::from_secs(60)).map_err(|_| {
        // Drop the pending sender if we time out so a late response doesn't
        // leak the slot forever.
        if let Ok(mut p) = pending.lock() {
            p.remove(&id);
        }
        format!("{method}: timed out after 60s")
    })?;
    extract_result(method, resp)
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
