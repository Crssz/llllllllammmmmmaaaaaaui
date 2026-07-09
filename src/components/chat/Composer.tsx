import { useEffect, useRef, useState } from "react";
import { I } from "../../icons";
import { Recorder, fmtRecDuration } from "../Recorder";
import { api, type AudioAttachment, type ImageAttachment, type RunningInfo } from "../../lib/api";
import type { Recording } from "../../lib/useAudioRecorder";
import type { ChatMessage } from "../../state";
import { basename, estimateTokenUsage, fmtN, imageFormatFor } from "../../lib/chatUi";

// The message composer: textarea + attachment row + foot (reasoning toggle,
// port label, token badge, send/stop). Owns its own draft + pending-attachment
// state; hands a finished message to the screen via onSend. The screen resets
// pending state on chat switch by passing a fresh chatId (see effect below).
export function Composer({
  chatId,
  canSend,
  chatPending,
  server,
  onSend,
  cancelChat,
  reasoningEnabled,
  setReasoningEnabled,
  reasoningToggleActive,
  thinkingKnownUnsupported,
  reasoningTitle,
  messages,
  ctxMax,
}: Readonly<{
  chatId: string | undefined;
  canSend: boolean;
  chatPending: boolean;
  server: {
    running: boolean;
    ready: boolean;
    info: RunningInfo | null;
  };
  onSend: (text: string, audio: AudioAttachment | null, image: ImageAttachment | null) => void;
  cancelChat: () => void;
  reasoningEnabled: boolean;
  setReasoningEnabled: (v: boolean) => void;
  reasoningToggleActive: boolean;
  thinkingKnownUnsupported: boolean;
  reasoningTitle: string;
  messages: ChatMessage[];
  ctxMax: number;
}>) {
  const [draft, setDraft] = useState("");

  // Pending audio attachment for the next message: a local playback URL plus
  // the on-disk path that will travel with the message. Null when nothing is
  // queued. Replaced whenever the user records a new clip or picks a file.
  const [pendingAudio, setPendingAudio] = useState<{
    url: string | null;
    attachment: AudioAttachment;
  } | null>(null);
  const [savingAudio, setSavingAudio] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);

  // Pending image attachment for the next message: a data URL for the chip
  // preview plus the on-disk path + format that travel with the message.
  const [pendingImage, setPendingImage] = useState<{
    preview: string | null;
    attachment: ImageAttachment;
  } | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);

  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Free the playback object URL when it's replaced or the screen unmounts.
  useEffect(() => {
    const url = pendingAudio?.url;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [pendingAudio?.url]);

  // Reset pending attachments + their errors when switching chats. The draft
  // is intentionally preserved across chat switches (matches prior behavior).
  // Also focus the composer on chat switch / first mount so the user can type
  // straight away — but don't steal focus from an open modal (e.g. the
  // tool-approval dialog). Focusing a disabled textarea is a harmless no-op.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPendingAudio(null);
    setAudioError(null);
    setPendingImage(null);
    setImageError(null);
    if (typeof document !== "undefined" && !document.querySelector("dialog[open]")) {
      taRef.current?.focus();
    }
  }, [chatId]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }, [draft]);

  const submit = () => {
    if (chatPending || savingAudio) return;
    const text = draft.trim();
    const audio = pendingAudio?.attachment ?? null;
    const image = pendingImage?.attachment ?? null;
    // Allow media-only sends — same rule the slice enforces.
    if (!text && !audio && !image) return;
    setDraft("");
    setPendingAudio(null);
    setAudioError(null);
    setPendingImage(null);
    setImageError(null);
    onSend(text, audio, image);
  };

  // Persist a freshly recorded clip and queue it as the next message's audio.
  // We give each clip a unique filename so prior attachments keep playing back
  // — Transcribe.tsx reuses a single recording.wav, but Chat needs history.
  const handleClip = (clip: Recording) => {
    setAudioError(null);
    setSavingAudio(true);
    const url = URL.createObjectURL(new Blob([clip.bytes], { type: "audio/wav" }));
    const name = `chat-${clip.sampleRate}-${Math.floor(performance.now()).toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}.wav`;
    api
      .saveRecording(clip.bytes, name)
      .then((path) => {
        setPendingAudio({
          url,
          attachment: { path, format: "wav", duration_ms: clip.durationMs },
        });
      })
      .catch((e: unknown) => {
        URL.revokeObjectURL(url);
        const msg = e instanceof Error ? e.message : String(e);
        setAudioError(`Couldn't save the recording: ${msg}`);
      })
      .finally(() => setSavingAudio(false));
  };

  const pickAudioFile = async () => {
    try {
      const p = await api.pickAudio("Attach a wav/mp3 file");
      if (!p) return;
      const sep = p.includes("\\") ? "\\" : "/";
      const fname = p.split(sep).pop() || p;
      const ext = (fname.includes(".") ? fname.split(".").pop() : "")?.toLowerCase();
      const format = ext === "mp3" ? "mp3" : "wav";
      setAudioError(null);
      setPendingAudio({
        url: null,
        attachment: { path: p, format, duration_ms: null },
      });
    } catch {
      /* dialog cancelled — ignore */
    }
  };

  const clearPendingAudio = () => {
    setPendingAudio(null);
    setAudioError(null);
  };

  const pickImageFile = async () => {
    try {
      const p = await api.pickImage("Attach an image");
      if (!p) return;
      setImageError(null);
      const format = imageFormatFor(p);
      // Read the image now so the chip can show a thumbnail and we can record
      // its pixel dimensions. The same path is re-read at send time by the
      // slice — small cost, and it keeps the stored attachment a plain path.
      let preview: string | null = null;
      let width: number | null = null;
      let height: number | null = null;
      try {
        const payload = await api.readImageBase64(p);
        preview = `data:${payload.mime};base64,${payload.data}`;
        const dims = await new Promise<{ w: number; h: number } | null>((resolve) => {
          const img = new globalThis.Image();
          img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
          img.onerror = () => resolve(null);
          img.src = preview as string;
        });
        if (dims) {
          width = dims.w;
          height = dims.h;
        }
      } catch (e) {
        // Preview/dimension read failed — still queue the attachment by path;
        // the chip just won't show a thumbnail.
        const msg = e instanceof Error ? e.message : String(e);
        setImageError(`Couldn't preview the image: ${msg}`);
      }
      setPendingImage({
        preview,
        attachment: { path: p, format, width, height },
      });
    } catch {
      /* dialog cancelled — ignore */
    }
  };

  const clearPendingImage = () => {
    setPendingImage(null);
    setImageError(null);
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  // Anything queued to send: text OR an audio/image attachment.
  const hasInput = draft.trim().length > 0 || !!pendingAudio || !!pendingImage;

  // Explains why the attach buttons are disabled, mirroring their disable
  // conditions. canSend is `server.ready && a model is loaded`, so a false
  // canSend means the server isn't up, is still loading, or has no model.
  const notReadyReason = !server.running
    ? "Start the server on the Configure tab first"
    : !server.ready
      ? "Server is still loading the model"
      : "Pick a model first";

  // ── Token usage estimate ─────────────────────────────────────────────────
  const { draftTokens, usedTokens, pctOfCtx } = estimateTokenUsage(messages, draft, ctxMax);
  const tokenColor =
    pctOfCtx >= 95 ? "var(--red)" : pctOfCtx >= 80 ? "var(--yellow)" : "var(--muted)";

  return (
    <div className="composer">
      <textarea
        ref={taRef}
        placeholder={
          canSend
            ? "Send a message to the model… (Enter to send, Shift+Enter for newline)"
            : !server.running
              ? "Start the server on Configure first…"
              : !server.ready
                ? "Loading model — hold on…"
                : "Pick a model first…"
        }
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        disabled={!canSend}
      />
      <div className="composer-attachments">
        <Recorder compact disabled={chatPending || savingAudio || !canSend} onClip={handleClip} />
        <button
          className="composer-chip"
          onClick={pickAudioFile}
          disabled={chatPending || savingAudio || !canSend}
          title={
            !canSend
              ? notReadyReason
              : savingAudio
                ? "Waiting for the recording to save…"
                : chatPending
                  ? "Wait for the current response to finish"
                  : "Attach a wav/mp3 file"
          }
        >
          <I.Folder size={11} /> Audio file
        </button>
        <button
          className="composer-chip"
          onClick={pickImageFile}
          disabled={chatPending || !canSend}
          title={
            !canSend
              ? notReadyReason
              : chatPending
                ? "Wait for the current response to finish"
                : "Attach an image (vision model required)"
          }
        >
          <I.Image size={11} /> Image
        </button>
        {savingAudio && <span className="tr-rec-saving mono">saving recording…</span>}
        {audioError && <span className="tr-rec-err">{audioError}</span>}
        {imageError && <span className="tr-rec-err">{imageError}</span>}
        {pendingAudio && (
          <div className="tr-rec-chip">
            <I.Mic size={12} />
            <span className="mono">{basename(pendingAudio.attachment.path)}</span>
            {pendingAudio.attachment.duration_ms != null && (
              <span className="tr-rec-chip-dur mono">
                {fmtRecDuration(pendingAudio.attachment.duration_ms)}
              </span>
            )}
            {pendingAudio.url && <audio className="tr-rec-audio" controls src={pendingAudio.url} />}
            <div style={{ flex: 1 }} />
            <button
              className="btn ghost"
              onClick={clearPendingAudio}
              disabled={chatPending}
              title="Remove attached audio"
            >
              <I.X size={12} />
            </button>
          </div>
        )}
        {pendingImage && (
          <div className="tr-rec-chip">
            {pendingImage.preview ? (
              <img className="composer-img-thumb" src={pendingImage.preview} alt="attachment" />
            ) : (
              <I.Image size={12} />
            )}
            <span className="mono">{basename(pendingImage.attachment.path)}</span>
            {pendingImage.attachment.width != null && pendingImage.attachment.height != null && (
              <span className="tr-rec-chip-dur mono">
                {pendingImage.attachment.width}×{pendingImage.attachment.height}
              </span>
            )}
            <div style={{ flex: 1 }} />
            <button
              className="btn ghost"
              onClick={clearPendingImage}
              disabled={chatPending}
              title="Remove attached image"
            >
              <I.X size={12} />
            </button>
          </div>
        )}
      </div>
      <div className="composer-foot">
        <button
          className={
            "composer-chip" + (reasoningEnabled && reasoningToggleActive ? " toggled" : "")
          }
          onClick={() => setReasoningEnabled(!reasoningEnabled)}
          disabled={!reasoningToggleActive}
          title={reasoningTitle}
          style={reasoningToggleActive ? undefined : { opacity: 0.6 }}
        >
          <I.Brain size={11} /> Reasoning ·{" "}
          {thinkingKnownUnsupported ? "n/a" : reasoningEnabled ? "on" : "off"}
        </button>
        <span style={{ fontSize: 11.5, color: "var(--muted)" }}>
          {!server.running
            ? "(server stopped)"
            : !server.ready
              ? `→ :${server.info?.port} (loading…)`
              : `→ :${server.info?.port}/v1/chat/completions`}
        </span>
        <span className="spacer" />
        <span
          className="mono"
          title={`Approximate token count (chars ÷ 4 + role tags).\n${usedTokens} of ${ctxMax} context tokens used (${pctOfCtx.toFixed(0)}%).${
            draft ? `\nIncludes ${draftTokens} from the draft.` : ""
          }`}
          style={{
            fontSize: 11,
            color: tokenColor,
            padding: "2px 7px",
            border: `1px solid ${
              pctOfCtx >= 95
                ? "oklch(0.55 0.16 25 / 0.45)"
                : pctOfCtx >= 80
                  ? "oklch(0.62 0.13 85 / 0.45)"
                  : "var(--border)"
            }`,
            borderRadius: 4,
            cursor: "help",
            whiteSpace: "nowrap",
          }}
        >
          {fmtN(usedTokens)} / {fmtN(ctxMax)}
        </span>
        {chatPending ? (
          <button
            className="composer-send"
            title="Stop generating"
            onClick={cancelChat}
            style={{
              background: "var(--red)",
              color: "white",
            }}
          >
            <I.Stop size={13} />
          </button>
        ) : (
          <>
            <span className="kbd">↵</span>
            <button
              className="composer-send"
              title={
                !canSend
                  ? "Server / model not ready"
                  : savingAudio
                    ? "Waiting for the recording to save…"
                    : !hasInput
                      ? "Type a message or attach audio"
                      : "Send"
              }
              onClick={submit}
              disabled={!canSend || savingAudio || !hasInput}
              style={{ opacity: canSend && hasInput && !savingAudio ? 1 : 0.5 }}
            >
              <I.Send size={13} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
