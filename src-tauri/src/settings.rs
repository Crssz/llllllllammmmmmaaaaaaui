use std::fs;
use std::path::PathBuf;

use log::{debug, error, info};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::mcp::McpServerConfig;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedProfile {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub flags: serde_json::Value,
    #[serde(default)]
    pub model_path: Option<String>,
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
        };
        let encoded = serde_json::to_string(&s).unwrap();
        let decoded: Settings = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded.build_dir.as_deref(), Some("/tmp/builds"));
        assert_eq!(decoded.recent_dirs, vec!["/a", "/b"]);
        assert_eq!(decoded.reasoning_enabled, Some(false));
        assert_eq!(decoded.flags["ngl"], 99);
        assert_eq!(decoded.model_configs["/tmp/model.gguf"]["ctx"], 8192);
        assert_eq!(decoded.mmproj_pinned, vec!["/tmp/model.gguf".to_string()]);
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
    fn saved_profile_serde_keeps_optional_fields() {
        let p = SavedProfile {
            id: "id".into(),
            name: "n".into(),
            created_at: 1,
            flags: serde_json::json!({}),
            model_path: None,
        };
        let encoded = serde_json::to_string(&p).unwrap();
        let decoded: SavedProfile = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded.id, "id");
        assert!(decoded.model_path.is_none());
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
}
