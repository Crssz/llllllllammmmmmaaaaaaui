import { useEffect, useRef, useState, type HTMLAttributes, type ReactElement } from "react";
import { Streamdown } from "streamdown";
import { I } from "../icons";
import type { Agency } from "../data";
import { useAppStore, useCurrentChat, useChatMessages } from "../state";
import { useShallow } from "zustand/react/shallow";
import { ChatSidebar } from "../components/ChatSidebar";
import { Recorder, fmtRecDuration } from "../components/Recorder";
import { api, type AudioAttachment, type ImageAttachment } from "../lib/api";
import type { Recording } from "../lib/useAudioRecorder";

// Custom <pre> wrapper for code blocks: hides streamdown's built-in icons
// (we disable those via `controls={{ code: false }}` on the Streamdown root)
// and shows a hover-revealed Copy button instead.
function CodeBlockPre(props: Readonly<HTMLAttributes<HTMLPreElement>>) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  // Pull the language hint from the child <code className="language-xyz">.
  const child = props.children as ReactElement<{ className?: string }> | undefined;
  const langMatch = child?.props?.className && /language-(\S+)/.exec(child.props.className);
  const lang = langMatch?.[1] ?? "";

  const copy = () => {
    const text =
      preRef.current?.querySelector("code")?.textContent ?? preRef.current?.textContent ?? "";
    if (!text) return;
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        globalThis.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  return (
    <div className="md-codeblock">
      {lang && <span className="md-codeblock-lang mono">{lang}</span>}
      <button
        type="button"
        className="md-copy-btn"
        onClick={copy}
        aria-label="Copy code"
        title="Copy code"
      >
        {copied ? (
          <>
            <I.Check size={11} /> Copied
          </>
        ) : (
          <>
            <I.Copy size={11} /> Copy
          </>
        )}
      </button>
      <pre ref={preRef} {...props} />
    </div>
  );
}

const STREAMDOWN_COMPONENTS = { pre: CodeBlockPre } as const;

// Lazy-load an audio attachment off disk via the existing Rust read command,
// wrap it in a Blob, and play through the standard <audio> control. Avoids
// widening Tauri's asset-protocol scope for chat playback. The blob URL is
// revoked when the component unmounts or the path changes.
function MessageAudio({ audio }: Readonly<{ audio: AudioAttachment }>) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let created: string | null = null;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setErr(null);
    setUrl(null);
    api
      .readAudioBase64(audio.path)
      .then((payload) => {
        if (!alive) return;
        // base64 → Uint8Array → Blob URL. `atob` is fine here: WAV clips from
        // the recorder are small and the chat thread renders one at a time.
        const bin = atob(payload.data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes], { type: `audio/${payload.format}` });
        created = URL.createObjectURL(blob);
        setUrl(created);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [audio.path]);

  return (
    <div className="msg-audio">
      <I.Mic size={12} style={{ color: "var(--accent)" }} />
      {url ? (
        <audio controls preload="metadata" src={url} />
      ) : err ? (
        <span className="tr-rec-err" title={err}>
          audio unavailable
        </span>
      ) : (
        <span className="msg-audio-dur mono">loading…</span>
      )}
      {audio.duration_ms != null && (
        <span className="msg-audio-dur mono">{fmtRecDuration(audio.duration_ms)}</span>
      )}
      <span
        className="mono msg-audio-dur"
        title={audio.path}
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          maxWidth: 180,
        }}
      >
        {basename(audio.path)}
      </span>
    </div>
  );
}

// Lazy-load an image attachment off disk via the Rust read command and render
// it as a data URL (CSP already allows `img-src 'self' data: blob:`). Clicking
// the thumbnail opens a full-size overlay. Mirrors MessageAudio's lazy load so
// we don't widen Tauri's asset-protocol scope.
function MessageImage({ image }: Readonly<{ image: ImageAttachment }>) {
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    let alive = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setErr(null);
    setSrc(null);
    api
      .readImageBase64(image.path)
      .then((payload) => {
        if (!alive) return;
        setSrc(`data:${payload.mime};base64,${payload.data}`);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [image.path]);

  return (
    <div className="msg-image">
      {src ? (
        <button
          type="button"
          className="msg-image-thumb-btn"
          onClick={() => setZoomed(true)}
          title="Click to enlarge"
        >
          <img className="msg-image-thumb" src={src} alt={basename(image.path)} />
        </button>
      ) : err ? (
        <span className="tr-rec-err" title={err}>
          <I.Image size={12} /> image unavailable
        </span>
      ) : (
        <span className="msg-audio-dur mono">
          <I.Image size={12} /> loading…
        </span>
      )}
      <span
        className="mono msg-audio-dur"
        title={image.path}
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          maxWidth: 180,
        }}
      >
        {basename(image.path)}
      </span>
      {zoomed && src && (
        <button
          type="button"
          className="msg-image-overlay"
          onClick={() => setZoomed(false)}
          title="Click to close"
        >
          <img src={src} alt={basename(image.path)} />
        </button>
      )}
    </div>
  );
}

function basename(p: string): string {
  if (!p) return "";
  const sep = p.includes("\\") ? "\\" : "/";
  return p.split(sep).pop() || p;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toTimeString().slice(0, 5);
}

export function ChatScreen({ agency }: Readonly<{ agency: Agency }>) {
  const chatMessages = useChatMessages();
  const currentChat = useCurrentChat();
  const {
    chatPending,
    chatError,
    sendChat,
    cancelChat,
    server,
    flags,
    newChat,
    deleteChat,
    togglePinChat,
    editMessage,
    deleteMessage,
    resendFromMessage,
    reasoningEnabled,
    setReasoningEnabled,
    pendingToolApproval,
    approveTool,
    modelInfo,
  } = useAppStore(
    useShallow((s) => ({
      chatPending: s.chatPending,
      chatError: s.chatError,
      sendChat: s.sendChat,
      cancelChat: s.cancelChat,
      server: s.server,
      flags: s.flags,
      newChat: s.newChat,
      deleteChat: s.deleteChat,
      togglePinChat: s.togglePinChat,
      editMessage: s.editMessage,
      deleteMessage: s.deleteMessage,
      resendFromMessage: s.resendFromMessage,
      reasoningEnabled: s.reasoningEnabled,
      setReasoningEnabled: s.setReasoningEnabled,
      pendingToolApproval: s.pendingToolApproval,
      approveTool: s.approveTool,
      modelInfo: s.modelInfo,
    })),
  );
  const [sideOpen, setSideOpen] = useState(true);
  const [draft, setDraft] = useState("");
  const [hiddenThink, setHiddenThink] = useState<Set<number>>(new Set());
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");

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

  // Free the playback object URL when it's replaced or the screen unmounts.
  useEffect(() => {
    const url = pendingAudio?.url;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [pendingAudio?.url]);
  // Tick state to drive elapsed-time labels while a request is in flight.
  const [phaseTick, setPhaseTick] = useState(0);
  useEffect(() => {
    if (!chatPending) return;
    const id = setInterval(() => setPhaseTick((t) => t + 1), 250);
    return () => clearInterval(id);
  }, [chatPending]);
  // Reference phaseTick so the linter doesn't strip it; it triggers re-renders
  // for the time-elapsed labels below.
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  phaseTick;
  // Tag is "<idx>" for message, "<idx>:think" for reasoning. Cleared after 1.5s.
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const copyText = (text: string, key: string) => {
    if (!text) return;
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopiedKey(key);
        globalThis.setTimeout(() => {
          setCopiedKey((cur) => (cur === key ? null : cur));
        }, 1500);
      })
      .catch(() => {});
  };
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const approvalRef = useRef<HTMLDialogElement | null>(null);
  const atBottomRef = useRef(true);
  // Mirror of atBottomRef for use in render. Scroll handler updates the ref
  // every event but only flips state when the threshold is actually crossed,
  // so we don't get a re-render per scroll pixel.
  const [atBottom, setAtBottom] = useState(true);

  // Ticking "now" used to display streaming elapsed seconds without calling
  // the impure Date.now() during render. Only ticks while a request is
  // pending; idle chats incur no interval cost.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!chatPending) return;
    const id = globalThis.setInterval(() => setNowTick(Date.now()), 250);
    return () => globalThis.clearInterval(id);
  }, [chatPending]);

  // Drive the tool-approval modal as a native <dialog>: showModal() gives us
  // the backdrop, Escape-to-close, and focus trapping for free.
  useEffect(() => {
    const dlg = approvalRef.current;
    if (!dlg) return;
    if (pendingToolApproval && !dlg.open) dlg.showModal();
    else if (!pendingToolApproval && dlg.open) dlg.close();
  }, [pendingToolApproval]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }, [draft]);

  // Reset hidden-think + edit state when switching chats. Deriving these
  // from the chat ID would require carrying per-chat UI state, which isn't
  // worth it — these are intentionally transient.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHiddenThink(new Set());
    setEditingIdx(null);
    setPendingAudio(null);
    setAudioError(null);
    setPendingImage(null);
    setImageError(null);
  }, [currentChat?.id]);

  const startEdit = (idx: number, content: string) => {
    setEditingIdx(idx);
    setEditDraft(content);
  };
  const cancelEdit = () => {
    setEditingIdx(null);
    setEditDraft("");
  };
  const saveEdit = () => {
    if (editingIdx === null || !currentChat) return;
    editMessage(currentChat.id, editingIdx, editDraft);
    setEditingIdx(null);
    setEditDraft("");
  };
  const onDelete = (idx: number) => {
    if (!currentChat) return;
    deleteMessage(currentChat.id, idx);
    if (editingIdx === idx) cancelEdit();
  };
  const onResend = (idx: number) => {
    if (!currentChat || chatPending) return;
    resendFromMessage(currentChat.id, idx).catch(() => {});
  };

  // Track whether the user is near the bottom; only auto-scroll if so.
  const onScroll = () => {
    const el = threadRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    const next = dist < 80;
    atBottomRef.current = next;
    setAtBottom((prev) => (prev === next ? prev : next));
  };

  // Auto-scroll on every message-list change (incl. mid-stream patches).
  // `updated_at` bumps with each patchAssistantContent so this fires reliably.
  useEffect(() => {
    if (!atBottomRef.current) return;
    const el = threadRef.current;
    if (!el) return;
    // Use rAF so we measure after the new content has laid out.
    const id = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [chatMessages, currentChat?.updated_at, chatPending]);

  const scrollToBottom = () => {
    const el = threadRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      atBottomRef.current = true;
      setAtBottom(true);
    }
  };

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
    sendChat(text, audio, image).catch(() => {});
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

  // Map a picked image path to its canonical format. Mirrors the Rust mapping
  // so the persisted attachment matches what the server will receive.
  const imageFormatFor = (path: string): string => {
    const ext = (path.includes(".") ? path.split(".").pop() : "")?.toLowerCase() ?? "";
    if (ext === "jpg" || ext === "jpeg") return "jpeg";
    if (ext === "png" || ext === "gif" || ext === "webp") return ext;
    return "png";
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

  const modelName = flags.model ? basename(flags.model as string) : "no model";
  const canSend = server.ready && !!flags.model;
  // Anything queued to send: text OR an audio/image attachment.
  const hasInput = draft.trim().length > 0 || !!pendingAudio || !!pendingImage;

  // Reasoning toggle state. The toggle only does anything when --jinja is on
  // AND the loaded model's chat template actually exposes `enable_thinking`
  // (derived from the GGUF). `null` modelInfo (not yet inspected) is treated
  // as "maybe" — we don't grey it out on uncertainty.
  const thinkingKnownUnsupported = modelInfo?.supports_thinking === false;
  const reasoningToggleActive = flags.jinja === true && !thinkingKnownUnsupported;
  const reasoningTitle = !flags.jinja
    ? "Enable --jinja in Configure → Templates for this toggle to take effect."
    : thinkingKnownUnsupported
      ? `This model's chat template has no thinking mode${
          modelInfo?.thinking_style ? ` (style: ${modelInfo.thinking_style})` : ""
        } — the toggle has no effect.`
      : `Toggle 'enable_thinking' in chat_template_kwargs. Currently ${
          reasoningEnabled ? "on" : "off"
        }.${modelInfo?.thinking_style ? ` Template style: ${modelInfo.thinking_style}.` : ""}`;

  // ── Token usage estimate ─────────────────────────────────────────────────
  // We don't ship a tokenizer in the UI, so this uses the standard 4-chars-
  // per-token heuristic plus a small role-tag overhead per message. Decent
  // for English; can be wired to llama-server's /tokenize later for accuracy.
  const approxTokens = (s: string) => Math.ceil((s?.length ?? 0) / 4);
  const ROLE_TAG_OVERHEAD = 4;
  const ctxMax = typeof flags.ctx === "number" && flags.ctx > 0 ? flags.ctx : 4096;
  const historyTokens = chatMessages.reduce(
    (n, m) => n + approxTokens(m.content) + ROLE_TAG_OVERHEAD,
    0,
  );
  const draftTokens = approxTokens(draft) + (draft ? ROLE_TAG_OVERHEAD : 0);
  const usedTokens = historyTokens + draftTokens;
  const tokenCount = historyTokens; // page-head badge keeps showing committed history
  const pctOfCtx = ctxMax > 0 ? (usedTokens / ctxMax) * 100 : 0;
  const tokenColor =
    pctOfCtx >= 95 ? "var(--red)" : pctOfCtx >= 80 ? "var(--yellow)" : "var(--muted)";
  const fmtN = (n: number) =>
    n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);

  return (
    <div className="chat-shell">
      <div className="chat-wrap">
        <div className="page-head">
          <div>
            <div className="crumb">
              Chats / {currentChat?.pinned ? "Pinned" : currentChat ? "Recent" : "New"}
            </div>
            <h1>
              {currentChat?.title ?? (chatMessages.length === 0 ? "Start a chat" : "Conversation")}
            </h1>
          </div>
          <div className="head-meta">
            <span className="badge ghost mono">~{tokenCount} tokens</span>
            <span className="badge accent" title={modelName}>
              <span
                className="dot"
                style={{
                  background: !server.running
                    ? "var(--muted)"
                    : server.ready
                      ? "var(--green)"
                      : "var(--yellow)",
                }}
              />
              <span className="model-name">{modelName}</span>
            </span>
            {flags.spec_type === "draft-mtp" && (
              <span className="badge ghost">
                <I.Spark size={11} /> MTP
              </span>
            )}
            {currentChat && (
              <button
                className="btn ghost"
                title={currentChat.pinned ? "Unpin chat" : "Pin chat"}
                onClick={() => togglePinChat(currentChat.id)}
                style={{
                  color: currentChat.pinned ? "var(--accent)" : undefined,
                }}
              >
                <I.Pin size={12} />
              </button>
            )}
            <button className="btn ghost" title="New chat" onClick={newChat}>
              <I.Plus size={12} />
            </button>
            {currentChat && (
              <button
                className="btn ghost"
                title="Delete chat"
                onClick={() => {
                  if (confirm("Delete this conversation?")) {
                    deleteChat(currentChat.id);
                  }
                }}
              >
                <I.X size={12} />
              </button>
            )}
          </div>
        </div>

        <div className="chat-thread" ref={threadRef} onScroll={onScroll}>
          {chatMessages.length === 0 && (
            <div
              style={{
                margin: "auto",
                maxWidth: 480,
                textAlign: "center",
                color: "var(--muted)",
                padding: "32px 16px",
              }}
            >
              <I.Chat size={32} style={{ color: "var(--accent)", marginBottom: 12 }} />
              <div
                style={{
                  fontSize: 15,
                  color: "var(--text)",
                  fontWeight: 500,
                  marginBottom: 6,
                }}
              >
                {!server.running
                  ? "Server is not running"
                  : !server.ready
                    ? "Loading model…"
                    : "Send your first message"}
              </div>
              <div style={{ fontSize: 12.5, lineHeight: 1.55 }}>
                {!server.running
                  ? "Open Configure, pick your llama.cpp build + a model, then press Start."
                  : !server.ready
                    ? `Waiting for llama-server on :${server.info?.port} to finish loading the model.`
                    : `Talking to the model at 127.0.0.1:${server.info?.port} via /v1/chat/completions.`}
              </div>
            </div>
          )}

          {chatMessages.map((m, i) => {
            if (m.role === "tool") {
              return (
                <div key={i} className="msg tool-msg">
                  <div className="msg-head">
                    <I.Globe size={11} style={{ color: "var(--accent)" }} />
                    <span className="who mono" style={{ color: "var(--accent)" }}>
                      {m.tool_name ?? "tool"}
                    </span>
                    <span className="time mono">{fmtTime(m.time)}</span>
                  </div>
                  <pre className="tool-msg-body mono">{m.content}</pre>
                </div>
              );
            }
            if (m.role === "system") {
              return (
                <div key={i} className="msg system-msg">
                  <div className="msg-head">
                    <I.Info size={11} style={{ color: "var(--muted)" }} />
                    <span className="who" style={{ color: "var(--muted)" }}>
                      system prompt
                    </span>
                    <span className="time mono">{fmtTime(m.time)}</span>
                  </div>
                  <div className="system-msg-body">{m.content}</div>
                </div>
              );
            }
            const isLast = i === chatMessages.length - 1;
            const streaming = chatPending && isLast && m.role === "assistant";
            const reasoning = m.reasoning?.trim();
            const showReasoning = !!reasoning && !hiddenThink.has(i);
            const thinkingOnly = streaming && !m.content && reasoning;
            const isEditing = editingIdx === i;
            const canActOnMessage = !streaming && !isEditing;
            // Phase derivation while streaming:
            //   prompt   — request sent, server hasn't emitted any delta yet
            //   thinking — reasoning_content / <think> tokens flowing, no content yet
            //   responding — actual response content flowing
            const phase: "prompt" | "thinking" | "responding" | null = streaming
              ? m.content
                ? "responding"
                : reasoning
                  ? "thinking"
                  : "prompt"
              : null;
            const elapsedS = streaming ? (nowTick - m.time) / 1000 : 0;
            return (
              <div key={i} className={"msg " + (m.role === "user" ? "user" : "model")}>
                <div className="msg-head">
                  <span
                    className="who"
                    style={m.role === "assistant" ? { color: "var(--accent)" } : undefined}
                  >
                    {m.role === "user" ? "You" : modelName}
                  </span>
                  <span className="time mono">{fmtTime(m.time)}</span>
                  {phase === "prompt" && (
                    <span
                      className="badge yellow"
                      style={{ marginLeft: "auto" }}
                      title="Server is evaluating the prompt — no tokens have streamed yet"
                    >
                      <span className="phase-dot" /> processing prompt · {elapsedS.toFixed(1)}s
                    </span>
                  )}
                  {phase === "thinking" && (
                    <span
                      className="badge accent"
                      style={{ marginLeft: "auto" }}
                      title="Model is generating reasoning tokens"
                    >
                      <I.Brain size={11} /> thinking · {elapsedS.toFixed(1)}s
                    </span>
                  )}
                  {phase === "responding" && (
                    <span
                      className="badge ghost"
                      style={{ marginLeft: "auto", color: "var(--accent)" }}
                      title="Model is generating the response"
                    >
                      <I.Bolt size={11} /> responding · {elapsedS.toFixed(1)}s
                    </span>
                  )}
                  {!streaming && m.meta?.tps !== undefined && (
                    <span className="badge ghost" style={{ marginLeft: "auto" }}>
                      <I.Bolt size={11} /> {m.meta.tps.toFixed(1)} tok/s
                      {m.meta.tokens ? ` · ${m.meta.tokens} tok` : ""}
                    </span>
                  )}
                </div>

                {reasoning && (
                  <div
                    className="thinking-card"
                    style={{
                      flexDirection: "column",
                      alignItems: "stretch",
                      gap: 6,
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        color: "var(--muted)",
                        fontSize: 11.5,
                      }}
                    >
                      <I.Brain size={13} />
                      <span>
                        {thinkingOnly
                          ? `Thinking… ${elapsedS.toFixed(1)}s`
                          : `Thought · ${reasoning.length} chars`}
                      </span>
                      <span style={{ flex: 1 }} />
                      {reasoning && (
                        <button
                          className="btn ghost"
                          style={{ padding: "1px 6px", fontSize: 11 }}
                          onClick={() => copyText(reasoning, `${i}:think`)}
                          title="Copy reasoning"
                        >
                          {copiedKey === `${i}:think` ? (
                            <>
                              <I.Check size={11} /> copied
                            </>
                          ) : (
                            <>
                              <I.Copy size={11} /> copy
                            </>
                          )}
                        </button>
                      )}
                      <button
                        className="btn ghost"
                        style={{ padding: "1px 6px", fontSize: 11 }}
                        onClick={() => {
                          const next = new Set(hiddenThink);
                          if (next.has(i)) next.delete(i);
                          else next.add(i);
                          setHiddenThink(next);
                        }}
                      >
                        {showReasoning ? "hide" : "show"}
                      </button>
                    </div>
                    {showReasoning && (
                      <div
                        className="md-output md-reasoning"
                        style={{
                          fontSize: 12,
                          color: "var(--text-2)",
                          lineHeight: 1.5,
                          borderLeft: "2px solid var(--accent-line)",
                          paddingLeft: 10,
                          marginTop: 2,
                        }}
                      >
                        <Streamdown
                          mode={thinkingOnly ? "streaming" : "static"}
                          parseIncompleteMarkdown
                          controls={{ code: false }}
                          components={STREAMDOWN_COMPONENTS}
                        >
                          {reasoning}
                        </Streamdown>
                        {thinkingOnly && (
                          <span
                            style={{
                              display: "inline-block",
                              width: 6,
                              height: 12,
                              marginLeft: 2,
                              background: "var(--accent)",
                              verticalAlign: "text-bottom",
                              animation: "spin 1s steps(2) infinite",
                              opacity: 0.7,
                            }}
                          />
                        )}
                      </div>
                    )}
                  </div>
                )}

                {isEditing ? (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                      background: "var(--bg-elev)",
                      border: "1px solid var(--accent-line)",
                      borderRadius: 10,
                      padding: 8,
                    }}
                  >
                    <textarea
                      autoFocus
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          e.preventDefault();
                          cancelEdit();
                        } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                          e.preventDefault();
                          saveEdit();
                        }
                      }}
                      style={{
                        background: "transparent",
                        border: 0,
                        outline: 0,
                        color: "var(--text)",
                        fontSize: 13.5,
                        lineHeight: 1.55,
                        fontFamily: "inherit",
                        resize: "vertical",
                        minHeight: 80,
                        padding: "8px 10px",
                      }}
                    />
                    <div
                      style={{
                        display: "flex",
                        gap: 6,
                        justifyContent: "flex-end",
                        alignItems: "center",
                      }}
                    >
                      <span
                        style={{
                          fontSize: 11,
                          color: "var(--muted)",
                          marginRight: "auto",
                        }}
                      >
                        <span className="kbd">⌘↵</span> save · <span className="kbd">esc</span>{" "}
                        cancel
                      </span>
                      <button className="btn ghost" onClick={cancelEdit}>
                        Cancel
                      </button>
                      <button className="btn primary" onClick={saveEdit}>
                        <I.Check size={11} /> Save
                      </button>
                    </div>
                  </div>
                ) : (
                  (m.content || (streaming && !reasoning)) && (
                    <div
                      className={
                        "msg-body" +
                        (m.role === "assistant" ? " md-output md-bubble" : " md-output")
                      }
                      style={
                        m.role === "assistant"
                          ? {
                              background: "var(--bg-elev)",
                              border: "1px solid var(--border)",
                              borderRadius: 10,
                              padding: "12px 14px",
                              minHeight: streaming && !m.content ? 36 : undefined,
                            }
                          : undefined
                      }
                    >
                      {streaming && !m.content ? (
                        <span
                          style={{
                            color: "var(--muted)",
                            fontStyle: "italic",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 8,
                          }}
                        >
                          <span
                            className="phase-dot"
                            style={{
                              color: phase === "prompt" ? "var(--yellow)" : "var(--accent)",
                            }}
                          />
                          {phase === "prompt"
                            ? `Processing prompt… ${elapsedS.toFixed(1)}s`
                            : `Thinking… ${elapsedS.toFixed(1)}s`}
                        </span>
                      ) : (
                        <>
                          <Streamdown
                            mode={streaming ? "streaming" : "static"}
                            parseIncompleteMarkdown
                            controls={{ code: false }}
                            components={STREAMDOWN_COMPONENTS}
                          >
                            {m.content}
                          </Streamdown>
                          {streaming && (
                            <span
                              style={{
                                display: "inline-block",
                                width: 7,
                                height: 14,
                                marginLeft: 2,
                                background: "var(--accent)",
                                verticalAlign: "text-bottom",
                                animation: "spin 1s steps(2) infinite",
                                opacity: 0.7,
                              }}
                            />
                          )}
                        </>
                      )}
                    </div>
                  )
                )}

                {m.role === "user" && m.image?.path && <MessageImage image={m.image} />}
                {m.role === "user" && m.audio?.path && <MessageAudio audio={m.audio} />}

                {m.tool_calls && m.tool_calls.length > 0 && (
                  <div className="tool-calls-block">
                    {m.tool_calls.map((tc) => (
                      <div key={tc.id} className="tool-call-row">
                        <I.Bolt size={11} style={{ color: "var(--accent)" }} />
                        <span className="mono" style={{ fontSize: 11.5, color: "var(--text-2)" }}>
                          {tc.function.name}
                        </span>
                        <span
                          className="mono"
                          style={{
                            fontSize: 11,
                            color: "var(--muted)",
                            flex: 1,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                          title={tc.function.arguments}
                        >
                          {tc.function.arguments}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {canActOnMessage && (
                  <div className="msg-tools">
                    <button
                      className="btn ghost"
                      style={{ padding: "3px 8px" }}
                      onClick={() => copyText(m.content, String(i))}
                      disabled={!m.content}
                      title="Copy message"
                    >
                      {copiedKey === String(i) ? (
                        <>
                          <I.Check size={11} /> Copied
                        </>
                      ) : (
                        <>
                          <I.Copy size={11} /> Copy
                        </>
                      )}
                    </button>
                    {m.role === "user" && (
                      <button
                        className="btn ghost"
                        style={{ padding: "3px 8px" }}
                        onClick={() => onResend(i)}
                        disabled={chatPending || !server.ready}
                        title="Resend (regenerates from this point)"
                      >
                        <I.Refresh size={11} /> Resend
                      </button>
                    )}
                    <button
                      className="btn ghost"
                      style={{ padding: "3px 8px" }}
                      onClick={() => startEdit(i, m.content)}
                      disabled={chatPending}
                      title="Edit message"
                    >
                      <I.Sliders size={11} /> Edit
                    </button>
                    <button
                      className="btn ghost"
                      style={{ padding: "3px 8px", color: "var(--red)" }}
                      onClick={() => onDelete(i)}
                      disabled={chatPending}
                      title="Delete message"
                    >
                      <I.X size={11} /> Delete
                    </button>
                  </div>
                )}
              </div>
            );
          })}

          {!atBottom && chatPending && (
            <button
              className="btn"
              style={{
                position: "sticky",
                bottom: 8,
                alignSelf: "center",
                boxShadow: "var(--shadow-md)",
              }}
              onClick={scrollToBottom}
              title="Jump to latest"
            >
              <I.Chevron size={12} /> Jump to latest
            </button>
          )}

          {chatError && (
            <div
              style={{
                padding: "10px 14px",
                background: "var(--red-soft)",
                border: "1px solid oklch(0.55 0.16 25 / 0.45)",
                borderRadius: "var(--radius)",
                color: "var(--red)",
                fontSize: 12.5,
              }}
            >
              <I.Info size={13} style={{ verticalAlign: -2, marginRight: 6 }} />
              {chatError}
            </div>
          )}
        </div>

        {agency !== "manual" && (
          <div className="empty-hint">
            <I.Spark size={16} />
            <div>
              <b>Pilot is {agency === "suggest" ? "watching" : "in control"}.</b>{" "}
              <span style={{ color: "var(--muted)" }}>
                {agency === "suggest"
                  ? "It will surface inline recommendations on the Configure tab."
                  : "Settings marked with a purple line are managed automatically. Switch to Manual to take over."}
              </span>
            </div>
          </div>
        )}

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
            <Recorder
              compact
              disabled={chatPending || savingAudio || !canSend}
              onClip={handleClip}
            />
            <button
              className="composer-chip"
              onClick={pickAudioFile}
              disabled={chatPending || savingAudio || !canSend}
              title="Attach a wav/mp3 file"
            >
              <I.Folder size={11} /> Audio file
            </button>
            <button
              className="composer-chip"
              onClick={pickImageFile}
              disabled={chatPending || !canSend}
              title="Attach an image (vision model required)"
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
                {pendingAudio.url && (
                  <audio className="tr-rec-audio" controls src={pendingAudio.url} />
                )}
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
                {pendingImage.attachment.width != null &&
                  pendingImage.attachment.height != null && (
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
              disabled={thinkingKnownUnsupported}
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
      </div>
      <ChatSidebar open={sideOpen} onToggle={() => setSideOpen((o) => !o)} />
      <dialog
        ref={approvalRef}
        className="tool-approval-card"
        onCancel={(e) => {
          // Escape key: treat as deny rather than a bare close. Approval is a
          // deliberate choice, so there is no click-outside-to-dismiss — the
          // explicit Deny button and Escape are the two ways out.
          e.preventDefault();
          if (pendingToolApproval) approveTool(pendingToolApproval.id, "deny");
        }}
      >
        {pendingToolApproval && (
          <>
            <div className="tool-approval-head">
              <I.Lock size={14} />
              <span>Approve tool call?</span>
            </div>
            <div className="tool-approval-body">
              <div className="tool-approval-row">
                <span className="lbl">Server</span>
                <span className="val mono">{pendingToolApproval.serverName}</span>
              </div>
              <div className="tool-approval-row">
                <span className="lbl">Tool</span>
                <span className="val mono">{pendingToolApproval.toolName}</span>
              </div>
              <div className="tool-approval-row" style={{ alignItems: "flex-start" }}>
                <span className="lbl">Arguments</span>
                <pre className="val mono tool-approval-args">
                  {JSON.stringify(pendingToolApproval.args, null, 2)}
                </pre>
              </div>
            </div>
            <ApprovalFooter
              onDecide={(decision, remember) =>
                approveTool(pendingToolApproval.id, decision, remember)
              }
            />
          </>
        )}
      </dialog>
    </div>
  );
}

function ApprovalFooter({
  onDecide,
}: Readonly<{
  onDecide: (decision: "allow" | "deny", remember: boolean) => void;
}>) {
  const [remember, setRemember] = useState(false);
  return (
    <div className="tool-approval-foot">
      <label className="mcp-check" style={{ marginRight: "auto" }}>
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />{" "}
        Remember for this session
      </label>
      <button className="btn" onClick={() => onDecide("deny", remember)}>
        <I.X size={11} /> Deny
      </button>
      <button className="btn primary" onClick={() => onDecide("allow", remember)}>
        <I.Check size={11} /> Allow
      </button>
    </div>
  );
}
