mod build_scan;
mod chats;
mod gguf;
mod hw;
mod mcp;
mod models_scan;
mod server;
mod settings;
mod transcribe;
mod util;

use std::sync::Mutex;

use log::{error, info};
use serde_json::Value as JsonValue;
use sysinfo::System;
use tauri::{AppHandle, Manager, State};

use crate::chats::{load_chats, save_chats};
use crate::gguf::inspect_gguf;
use crate::hw::{hw_snapshot, HwState};
use crate::mcp::{McpRegistry, McpStatus, McpTool};
use crate::server::{server_status, start_server, stop_server, ServerState};
use crate::settings::{load_settings, save_settings, Settings};
use crate::transcribe::{read_audio_base64, read_image_base64, save_recording};
use crate::util::{chrono_now_millis, lock_or_poisoned, push_recent};

// ── Glue commands ───────────────────────────────────────────────────────────
// These cross multiple domains (settings ↔ HwState, settings ↔ McpRegistry)
// and so are easiest to wire up here at the seam.

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
        .manage(ServerState::default())
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
            crate::build_scan::scan_build,
            crate::models_scan::scan_models,
            inspect_gguf,
            start_server,
            stop_server,
            server_status,
            save_recording,
            read_audio_base64,
            read_image_base64,
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
