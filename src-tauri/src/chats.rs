use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::settings::ChatSessionConfig;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    pub time: i64,
    #[serde(default)]
    pub tps: Option<f64>,
    #[serde(default)]
    pub tokens: Option<u32>,
    #[serde(default)]
    pub reasoning: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatSession {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub pinned: bool,
    pub messages: Vec<ChatMessage>,
    /// Per-session overrides (system prompt, MCP toggles, etc.). None means
    /// fall back to the global defaults.
    #[serde(default)]
    pub config: Option<ChatSessionConfig>,
}

fn chats_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    Ok(dir.join("chats.json"))
}

#[tauri::command]
pub fn load_chats(app: AppHandle) -> Result<Vec<ChatSession>, String> {
    let p = chats_path(&app)?;
    if !p.exists() {
        return Ok(Vec::new());
    }
    let s = fs::read_to_string(&p).map_err(|e| format!("read: {e}"))?;
    let chats: Vec<ChatSession> = serde_json::from_str(&s).map_err(|e| format!("parse: {e}"))?;
    Ok(chats)
}

#[tauri::command]
pub fn save_chats(app: AppHandle, chats: Vec<ChatSession>) -> Result<(), String> {
    let p = chats_path(&app)?;
    let s = serde_json::to_string(&chats).map_err(|e| format!("encode: {e}"))?;
    fs::write(&p, s).map_err(|e| format!("write: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_message_roundtrip_preserves_optional_fields() {
        let m = ChatMessage {
            role: "assistant".into(),
            content: "hi".into(),
            time: 1,
            tps: Some(12.5),
            tokens: Some(3),
            reasoning: Some("think".into()),
        };
        let encoded = serde_json::to_string(&m).unwrap();
        let decoded: ChatMessage = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded.role, "assistant");
        assert_eq!(decoded.tps, Some(12.5));
        assert_eq!(decoded.reasoning.as_deref(), Some("think"));
    }

    #[test]
    fn chat_session_decodes_missing_optional_fields() {
        let json = r#"{
            "id": "c1",
            "title": "t",
            "created_at": 1,
            "updated_at": 2,
            "messages": []
        }"#;
        let s: ChatSession = serde_json::from_str(json).unwrap();
        assert!(!s.pinned);
        assert!(s.config.is_none());
        assert!(s.messages.is_empty());
    }

    #[test]
    fn chat_session_roundtrip_keeps_pinned_and_config() {
        let s = ChatSession {
            id: "c1".into(),
            title: "t".into(),
            created_at: 1,
            updated_at: 2,
            pinned: true,
            messages: vec![ChatMessage {
                role: "user".into(),
                content: "hi".into(),
                time: 3,
                tps: None,
                tokens: None,
                reasoning: None,
            }],
            config: Some(ChatSessionConfig::default()),
        };
        let encoded = serde_json::to_string(&s).unwrap();
        let decoded: ChatSession = serde_json::from_str(&encoded).unwrap();
        assert!(decoded.pinned);
        assert!(decoded.config.is_some());
        assert_eq!(decoded.messages.len(), 1);
    }
}
