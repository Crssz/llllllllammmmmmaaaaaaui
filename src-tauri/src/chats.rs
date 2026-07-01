use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::settings::ChatSessionConfig;

/// Audio clip attached to a chat message. `path` points at a file on disk
/// (either a saved mic recording or a user-picked wav/mp3); `format` is what
/// llama-server expects in `input_audio.format`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioAttachment {
    pub path: String,
    pub format: String,
    #[serde(default)]
    pub duration_ms: Option<u64>,
}

/// Image attached to a chat message. `path` points at a user-picked image
/// file on disk; `format` is the canonical extension (`jpeg`/`png`/`gif`/
/// `webp`) used to build the `image_url` data URL. `width`/`height` are pure
/// UX hints filled in opportunistically by the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageAttachment {
    pub path: String,
    pub format: String,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
}

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
    /// Audio clip(s) attached to this message. Used on user messages so the
    /// composer can send `input_audio` to the model and the chat can still
    /// play the clip back after a reload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio: Option<AudioAttachment>,
    /// Image attached to this message. Used on user messages so the composer
    /// can send `image_url` to a vision model and re-render the picture after
    /// a reload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<ImageAttachment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatSession {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub pinned: bool,
    /// Workspace this chat belongs to, if any. `None` = no workspace (shows
    /// under "All chats", ungrouped). Independent of `config` — the
    /// workspace's config is only a seed at chat-creation time.
    #[serde(default)]
    pub workspace_id: Option<String>,
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
            audio: None,
            image: None,
        };
        let encoded = serde_json::to_string(&m).unwrap();
        let decoded: ChatMessage = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded.role, "assistant");
        assert_eq!(decoded.tps, Some(12.5));
        assert_eq!(decoded.reasoning.as_deref(), Some("think"));
    }

    #[test]
    fn chat_message_roundtrip_preserves_audio_attachment() {
        let m = ChatMessage {
            role: "user".into(),
            content: "".into(),
            time: 1,
            tps: None,
            tokens: None,
            reasoning: None,
            audio: Some(AudioAttachment {
                path: "C:/tmp/clip.wav".into(),
                format: "wav".into(),
                duration_ms: Some(2400),
            }),
            image: None,
        };
        let encoded = serde_json::to_string(&m).unwrap();
        let decoded: ChatMessage = serde_json::from_str(&encoded).unwrap();
        let audio = decoded.audio.expect("audio survives roundtrip");
        assert_eq!(audio.path, "C:/tmp/clip.wav");
        assert_eq!(audio.format, "wav");
        assert_eq!(audio.duration_ms, Some(2400));
    }

    #[test]
    fn chat_message_roundtrip_preserves_image_attachment() {
        let m = ChatMessage {
            role: "user".into(),
            content: "what is this?".into(),
            time: 1,
            tps: None,
            tokens: None,
            reasoning: None,
            audio: None,
            image: Some(ImageAttachment {
                path: "C:/tmp/pic.png".into(),
                format: "png".into(),
                width: Some(640),
                height: Some(480),
            }),
        };
        let encoded = serde_json::to_string(&m).unwrap();
        let decoded: ChatMessage = serde_json::from_str(&encoded).unwrap();
        let image = decoded.image.expect("image survives roundtrip");
        assert_eq!(image.path, "C:/tmp/pic.png");
        assert_eq!(image.format, "png");
        assert_eq!(image.width, Some(640));
        assert_eq!(image.height, Some(480));
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
        assert!(s.workspace_id.is_none());
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
            workspace_id: Some("w1".into()),
            messages: vec![ChatMessage {
                role: "user".into(),
                content: "hi".into(),
                time: 3,
                tps: None,
                tokens: None,
                reasoning: None,
                audio: None,
                image: None,
            }],
            config: Some(ChatSessionConfig::default()),
        };
        let encoded = serde_json::to_string(&s).unwrap();
        let decoded: ChatSession = serde_json::from_str(&encoded).unwrap();
        assert!(decoded.pinned);
        assert!(decoded.config.is_some());
        assert_eq!(decoded.workspace_id.as_deref(), Some("w1"));
        assert_eq!(decoded.messages.len(), 1);
    }
}
