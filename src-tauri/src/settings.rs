use std::fs;
use std::path::PathBuf;

use log::{debug, error, info};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::mcp::McpServerConfig;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default)]
    pub build_dir: Option<String>,
    #[serde(default)]
    pub recent_dirs: Vec<String>,
    #[serde(default)]
    pub model_path: Option<String>,
    #[serde(default)]
    pub flags: serde_json::Value,
    /// Per-model runtime config, keyed by absolute model path. Each model
    /// remembers its own flags (everything except the `model` path key, which
    /// is the map key) so selecting it again restores the same config.
    #[serde(default)]
    pub model_configs: std::collections::HashMap<String, serde_json::Value>,
    /// Model paths whose `mmproj` projector the user has set or cleared
    /// explicitly. For these the loader leaves `mmproj` alone instead of
    /// auto-detecting a sibling projector from the model's folder.
    #[serde(default)]
    pub mmproj_pinned: Vec<String>,
    #[serde(default)]
    pub models_dir: Option<String>,
    #[serde(default)]
    pub models_recent: Vec<String>,
    #[serde(default)]
    pub profiles: Vec<SavedProfile>,
    /// Toggles the `enable_thinking` chat_template_kwarg on outbound requests.
    /// None == use default (true) so older settings files still work.
    #[serde(default)]
    pub reasoning_enabled: Option<bool>,
    /// User-registered MCP servers.
    #[serde(default)]
    pub mcp_servers: Vec<McpServerConfig>,
    /// Reusable chat session presets (system prompt, MCP toggles, etc.).
    #[serde(default)]
    pub chat_presets: Vec<ChatPreset>,
    /// Workspaces group chats under a shared default config (system prompt,
    /// project folder, MCP servers, tool permissions). See `Workspace`.
    #[serde(default)]
    pub workspaces: Vec<Workspace>,
    /// Optional HuggingFace access token. When set, catalog requests send it as
    /// a Bearer token — lifts anonymous rate-limiting/throttling, enables the
    /// faster authenticated download path, and unlocks gated repos.
    #[serde(default)]
    pub hf_token: Option<String>,
    /// Which inference engine backs the server: "llama" (llama.cpp's
    /// llama-server, the default) or "hipfire" (the source-built hipfire
    /// binary). Settings files predating this key default to "llama" so
    /// behaviour is unchanged for existing installs.
    #[serde(default = "default_engine_kind")]
    pub engine_kind: String,
    /// Absolute path to the hipfire executable. Empty until the user sets it;
    /// consulted only when `engine_kind == "hipfire"`. Kept separate from
    /// `build_dir`, which stays llama-only (it also seeds the HIP DLL hint).
    #[serde(default)]
    pub hipfire_path: String,
    /// hipfire runtime flag bag, parallel to `flags` but consumed by the
    /// frontend's `buildHipfireArgs`. A **separate** bag from `flags` — never
    /// merged in. Keys: tag, host, port, kv_mode, idle_timeout, tp.
    /// (Speculation is NOT a serve flag — it's config-driven; see
    /// buildHipfireArgs.ts.)
    #[serde(default)]
    pub hipfire_flags: serde_json::Value,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            build_dir: Default::default(),
            recent_dirs: Default::default(),
            model_path: Default::default(),
            flags: Default::default(),
            model_configs: Default::default(),
            mmproj_pinned: Default::default(),
            models_dir: Default::default(),
            models_recent: Default::default(),
            profiles: Default::default(),
            reasoning_enabled: Default::default(),
            mcp_servers: Default::default(),
            chat_presets: Default::default(),
            workspaces: Default::default(),
            hf_token: Default::default(),
            // `#[serde(default = "...")]` only kicks in during deserialization —
            // a bare `derive(Default)` would leave this "" on first run (no
            // settings.json yet), silently picking neither engine. Match the
            // serde default explicitly so `Settings::default()` and a
            // from-empty-JSON parse agree.
            engine_kind: default_engine_kind(),
            hipfire_path: Default::default(),
            hipfire_flags: Default::default(),
        }
    }
}

/// Reusable bundle of per-session chat configuration. Saved at the top level
/// so a user can apply the same setup to multiple sessions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatPreset {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    #[serde(default)]
    pub config: ChatSessionConfig,
}

/// Groups multiple chats under a shared default config. Membership is
/// tracked on each `ChatSession` via `workspace_id`, independent of
/// `ChatPreset` linkage — a chat can belong to a workspace, optionally apply
/// a preset, and diverge in its own config without affecting either.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    /// Default config applied to new chats created inside this workspace.
    #[serde(default)]
    pub config: ChatSessionConfig,
}

/// Per-session chat config. Stored on each ChatSession when overridden.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ChatSessionConfig {
    #[serde(default)]
    pub system_prompt: Option<String>,
    /// Optional client-side chat template override. When present, requests
    /// include `chat_template` so llama-server uses it instead of the
    /// model-default template.
    #[serde(default)]
    pub chat_template: Option<String>,
    /// IDs of MCP servers enabled for this session. Tools are pulled from
    /// these servers and offered to the model.
    #[serde(default)]
    pub mcp_server_ids: Vec<String>,
    /// Default tool-permission policy and per-tool overrides.
    #[serde(default)]
    pub tool_permissions: ToolPermissions,
    /// Absolute path of the project folder opened for this session. When set,
    /// the chat offers the built-in `workspace__*` file tools rooted here.
    #[serde(default)]
    pub workspace_root: Option<String>,
    /// If this session was hydrated from a preset, remember the preset id so
    /// the UI can show "linked" state.
    #[serde(default)]
    pub preset_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolPermissions {
    /// One of: "allow" | "ask" | "deny"
    #[serde(default = "default_policy")]
    pub default: String,
    /// "<serverId>:<toolName>" → policy. Falls back to `default` if missing.
    #[serde(default)]
    pub per_tool: std::collections::HashMap<String, String>,
}

impl Default for ToolPermissions {
    fn default() -> Self {
        Self {
            default: default_policy(),
            per_tool: Default::default(),
        }
    }
}

fn default_policy() -> String {
    "ask".to_string()
}

fn default_engine_kind() -> String {
    "llama".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedProfile {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub flags: serde_json::Value,
    #[serde(default)]
    pub model_path: Option<String>,
    /// Engine active when this profile was saved. Profiles saved before the
    /// engine axis existed default to "llama" so they still restore correctly.
    #[serde(default = "default_engine_kind")]
    pub engine_kind: String,
    /// hipfire runtime flag bag snapshotted alongside `flags`. Empty/null for
    /// profiles saved under llama (or predating this key).
    #[serde(default)]
    pub hipfire_flags: serde_json::Value,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    Ok(dir.join("settings.json"))
}

#[tauri::command]
pub fn load_settings(app: AppHandle) -> Result<Settings, String> {
    let p = settings_path(&app)?;
    if !p.exists() {
        info!("settings: no existing file at {}", p.display());
        return Ok(Settings::default());
    }
    let s = fs::read_to_string(&p).map_err(|e| {
        error!("settings read failed: {e}");
        format!("read: {e}")
    })?;
    let parsed: Settings = serde_json::from_str(&s).map_err(|e| {
        error!("settings parse failed: {e}");
        format!("parse: {e}")
    })?;
    info!(
        "settings loaded ({} bytes, {} profiles, {} recent build dirs, {} recent models dirs)",
        s.len(),
        parsed.profiles.len(),
        parsed.recent_dirs.len(),
        parsed.models_recent.len(),
    );
    Ok(parsed)
}

#[tauri::command]
pub fn save_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    let p = settings_path(&app)?;
    let s = serde_json::to_string_pretty(&settings).map_err(|e| {
        error!("settings encode failed: {e}");
        format!("encode: {e}")
    })?;
    fs::write(&p, &s).map_err(|e| {
        error!("settings write failed: {e}");
        format!("write: {e}")
    })?;
    debug!("settings saved ({} bytes)", s.len());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_roundtrip_preserves_known_fields() {
        let s = Settings {
            build_dir: Some("/tmp/builds".into()),
            recent_dirs: vec!["/a".into(), "/b".into()],
            model_path: Some("/tmp/model.gguf".into()),
            flags: serde_json::json!({ "ngl": 99, "fa": true }),
            model_configs: [(
                "/tmp/model.gguf".to_string(),
                serde_json::json!({ "ngl": 99, "ctx": 8192 }),
            )]
            .into_iter()
            .collect(),
            mmproj_pinned: vec!["/tmp/model.gguf".to_string()],
            models_dir: None,
            models_recent: vec![],
            profiles: vec![],
            reasoning_enabled: Some(false),
            mcp_servers: vec![],
            chat_presets: vec![],
            workspaces: vec![],
            hf_token: Some("hf_test".into()),
            engine_kind: "hipfire".into(),
            hipfire_path: "C:/hipfire/hipfire.exe".into(),
            hipfire_flags: serde_json::json!({ "tag": "qwen3.6:27b", "port": 8090 }),
        };
        let encoded = serde_json::to_string(&s).unwrap();
        let decoded: Settings = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded.build_dir.as_deref(), Some("/tmp/builds"));
        assert_eq!(decoded.recent_dirs, vec!["/a", "/b"]);
        assert_eq!(decoded.reasoning_enabled, Some(false));
        assert_eq!(decoded.flags["ngl"], 99);
        assert_eq!(decoded.model_configs["/tmp/model.gguf"]["ctx"], 8192);
        assert_eq!(decoded.mmproj_pinned, vec!["/tmp/model.gguf".to_string()]);
        assert_eq!(decoded.hf_token.as_deref(), Some("hf_test"));
        assert_eq!(decoded.engine_kind, "hipfire");
        assert_eq!(decoded.hipfire_path, "C:/hipfire/hipfire.exe");
        assert_eq!(decoded.hipfire_flags["tag"], "qwen3.6:27b");
        assert_eq!(decoded.hipfire_flags["port"], 8090);
    }

    #[test]
    fn settings_decodes_missing_fields_as_defaults() {
        let minimal = r#"{}"#;
        let decoded: Settings = serde_json::from_str(minimal).unwrap();
        assert!(decoded.recent_dirs.is_empty());
        assert!(decoded.profiles.is_empty());
        assert_eq!(decoded.reasoning_enabled, None);
        assert!(decoded.model_configs.is_empty());
        assert!(decoded.mmproj_pinned.is_empty());
        assert!(decoded.workspaces.is_empty());
        assert_eq!(decoded.engine_kind, "llama");
        assert!(decoded.hipfire_path.is_empty());
        assert!(decoded.hipfire_flags.is_null());
    }

    #[test]
    fn settings_default_engine_kind_is_llama() {
        // First-run `Settings::default()` (no settings.json yet) must agree
        // with the serde missing-field default, or first launch silently
        // picks neither engine. This is the exact trap zinc hit: a bare
        // `derive(Default)` would leave engine_kind == "" here.
        let s = Settings::default();
        assert_eq!(s.engine_kind, "llama");
        assert!(s.hipfire_path.is_empty());
        assert!(s.hipfire_flags.is_null());
    }

    #[test]
    fn settings_legacy_json_without_engine_keys_loads_as_llama() {
        // A settings.json written before the engine axis existed carries the
        // old keys but none of engine_kind / hipfire_path / hipfire_flags. It
        // must still load, defaulting to the llama engine with an empty
        // hipfire config, so existing installs behave byte-identically.
        let legacy = r#"{
            "build_dir": "/tmp/builds",
            "recent_dirs": ["/a"],
            "model_path": "/tmp/m.gguf",
            "flags": { "ngl": 99 },
            "reasoning_enabled": true
        }"#;
        let decoded: Settings = serde_json::from_str(legacy).unwrap();
        assert_eq!(decoded.engine_kind, "llama");
        assert!(decoded.hipfire_path.is_empty());
        assert!(decoded.hipfire_flags.is_null());
        assert_eq!(decoded.build_dir.as_deref(), Some("/tmp/builds"));
        assert_eq!(decoded.flags["ngl"], 99);
    }

    #[test]
    fn tool_permissions_default_is_ask_with_empty_overrides() {
        let p = ToolPermissions::default();
        assert_eq!(p.default, "ask");
        assert!(p.per_tool.is_empty());
    }

    #[test]
    fn chat_session_config_defaults_are_none_or_empty() {
        let c = ChatSessionConfig::default();
        assert!(c.system_prompt.is_none());
        assert!(c.chat_template.is_none());
        assert!(c.mcp_server_ids.is_empty());
        assert_eq!(c.tool_permissions.default, "ask");
        assert!(c.preset_id.is_none());
        assert!(c.workspace_root.is_none());
    }

    #[test]
    fn chat_preset_roundtrip_with_nested_config() {
        let p = ChatPreset {
            id: "p1".into(),
            name: "first".into(),
            created_at: 42,
            config: ChatSessionConfig {
                system_prompt: Some("be brief".into()),
                chat_template: None,
                mcp_server_ids: vec!["s1".into()],
                tool_permissions: ToolPermissions {
                    default: "allow".into(),
                    per_tool: [("s1:t".into(), "deny".into())].into_iter().collect(),
                },
                workspace_root: Some("C:/proj".into()),
                preset_id: None,
            },
        };
        let encoded = serde_json::to_string(&p).unwrap();
        let decoded: ChatPreset = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded.config.system_prompt.as_deref(), Some("be brief"));
        assert_eq!(decoded.config.tool_permissions.default, "allow");
        assert_eq!(decoded.config.tool_permissions.per_tool["s1:t"], "deny");
        assert_eq!(decoded.config.workspace_root.as_deref(), Some("C:/proj"));
    }

    #[test]
    fn workspace_roundtrip_with_nested_config() {
        let w = Workspace {
            id: "w1".into(),
            name: "first".into(),
            created_at: 42,
            config: ChatSessionConfig {
                system_prompt: Some("be brief".into()),
                chat_template: None,
                mcp_server_ids: vec!["s1".into()],
                tool_permissions: ToolPermissions {
                    default: "allow".into(),
                    per_tool: [("s1:t".into(), "deny".into())].into_iter().collect(),
                },
                workspace_root: Some("C:/proj".into()),
                preset_id: None,
            },
        };
        let encoded = serde_json::to_string(&w).unwrap();
        let decoded: Workspace = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded.name, "first");
        assert_eq!(decoded.config.system_prompt.as_deref(), Some("be brief"));
        assert_eq!(decoded.config.tool_permissions.default, "allow");
        assert_eq!(decoded.config.tool_permissions.per_tool["s1:t"], "deny");
        assert_eq!(decoded.config.workspace_root.as_deref(), Some("C:/proj"));
    }

    #[test]
    fn saved_profile_serde_keeps_optional_fields() {
        let p = SavedProfile {
            id: "id".into(),
            name: "n".into(),
            created_at: 1,
            flags: serde_json::json!({}),
            model_path: None,
            engine_kind: "hipfire".into(),
            hipfire_flags: serde_json::json!({ "tag": "qwen3.6:27b" }),
        };
        let encoded = serde_json::to_string(&p).unwrap();
        let decoded: SavedProfile = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded.id, "id");
        assert!(decoded.model_path.is_none());
        assert_eq!(decoded.engine_kind, "hipfire");
        assert_eq!(decoded.hipfire_flags["tag"], "qwen3.6:27b");
    }

    #[test]
    fn saved_profile_tolerates_legacy_agency_key() {
        // Profiles saved before the pilot-mode feature was removed carry an
        // "agency" key; loading them must not fail.
        let legacy =
            r#"{"id":"id","name":"n","created_at":1,"flags":{},"model_path":null,"agency":"auto"}"#;
        let decoded: SavedProfile = serde_json::from_str(legacy).unwrap();
        assert_eq!(decoded.id, "id");
    }

    #[test]
    fn saved_profile_without_engine_keys_defaults_to_llama() {
        // A profile saved before the engine axis existed carries none of
        // engine_kind / hipfire_flags. It must still load, defaulting to the
        // llama engine with an empty hipfire config.
        let legacy =
            r#"{"id":"id","name":"n","created_at":1,"flags":{"ngl":99},"model_path":"/m.gguf"}"#;
        let decoded: SavedProfile = serde_json::from_str(legacy).unwrap();
        assert_eq!(decoded.engine_kind, "llama");
        assert!(decoded.hipfire_flags.is_null());
        assert_eq!(decoded.flags["ngl"], 99);
        assert_eq!(decoded.model_path.as_deref(), Some("/m.gguf"));
    }
}
