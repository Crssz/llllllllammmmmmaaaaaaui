mod bench;
mod build_scan;
mod catalog;
mod chats;
mod engines;
mod gguf;
mod hipfire_convert;
mod hw;
mod mcp;
mod models_scan;
mod server;
mod settings;
mod transcribe;
mod util;
mod workspace;

use std::sync::Mutex;

use log::{error, info};
use serde_json::Value as JsonValue;
use sysinfo::System;
use tauri::{AppHandle, Manager, State};

use crate::bench::{cancel_bench, load_bench_runs, run_bench, save_bench_runs, BenchState};
use crate::catalog::{
    cancel_catalog_download, download_catalog_model, list_catalog_files, search_catalog,
    CatalogState,
};
use crate::chats::{load_chats, save_chats};
use crate::engines::{
    cancel_engine_download, delete_engine, download_engine, list_engine_releases,
    list_installed_engines, EngineState,
};
use crate::gguf::inspect_gguf;
use crate::hipfire_convert::{cancel_hipfire_convert, hipfire_convert, HipfireConvertState};
use crate::hw::{hw_snapshot, HwState};
use crate::mcp::{McpRegistry, McpStatus, McpTool};
use crate::server::{resolve_hipfire_bin_cmd, server_status, start_server, stop_server, ServerState};
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

// The MCP commands below are async + spawn_blocking: sync commands run on the
// main thread, and connect/call block on the child process (up to 60s per
// request) — inline they freeze the whole window for that long.

#[tauri::command]
async fn mcp_connect(app: AppHandle, id: String) -> Result<McpStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let settings = load_settings(app.clone())?;
        let cfg = settings
            .mcp_servers
            .into_iter()
            .find(|s| s.id == id)
            .ok_or_else(|| format!("MCP server {id} not found"))?;
        app.state::<McpRegistry>().connect(&cfg)
    })
    .await
    .map_err(|e| format!("mcp_connect task failed: {e}"))?
}

#[tauri::command]
async fn mcp_disconnect(app: AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<McpRegistry>().disconnect(&id);
    })
    .await
    .map_err(|e| format!("mcp_disconnect task failed: {e}"))
}

#[tauri::command]
fn mcp_list_tools(reg: State<'_, McpRegistry>, id: String) -> Result<Vec<McpTool>, String> {
    reg.list_tools(&id)
}

#[tauri::command]
async fn mcp_call_tool(
    app: AppHandle,
    id: String,
    name: String,
    arguments: JsonValue,
) -> Result<JsonValue, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<McpRegistry>().call_tool(&id, &name, arguments)
    })
    .await
    .map_err(|e| format!("mcp_call_tool task failed: {e}"))?
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
        .manage(BenchState::default())
        .manage(EngineState::default())
        .manage(CatalogState::default())
        .manage(HipfireConvertState::default())
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
            crate::models_scan::delete_model_file,
            inspect_gguf,
            start_server,
            stop_server,
            server_status,
            resolve_hipfire_bin_cmd,
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
            run_bench,
            cancel_bench,
            load_bench_runs,
            save_bench_runs,
            list_engine_releases,
            list_installed_engines,
            download_engine,
            cancel_engine_download,
            delete_engine,
            search_catalog,
            list_catalog_files,
            download_catalog_model,
            cancel_catalog_download,
            hipfire_convert,
            cancel_hipfire_convert,
            crate::workspace::workspace_list,
            crate::workspace::workspace_read,
            crate::workspace::workspace_write,
            crate::workspace::workspace_edit,
            crate::workspace::workspace_search,
            crate::workspace::workspace_find,
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
                if let Some(state) = window.try_state::<BenchState>() {
                    let mut child = lock_or_poisoned(&state.child);
                    if let Some(mut c) = child.take() {
                        let _ = c.kill();
                    }
                }
                if let Some(state) = window.try_state::<HipfireConvertState>() {
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
