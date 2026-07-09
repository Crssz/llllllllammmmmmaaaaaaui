import { useEffect, useRef, useState } from "react";
import { I } from "../icons";
import {
  useAppStore,
  useCurrentChat,
  useChatMessages,
  type ChatMessage as ChatMessageT,
} from "../state";
import { useShallow } from "zustand/react/shallow";
import { ChatSidebar } from "../components/ChatSidebar";
import { useContextMenu, type MenuItem } from "../components/ContextMenu";
import { useTextPrompt } from "../components/TextPromptDialog";
import { useConfirm } from "../components/ConfirmDialog";
import { ChatMessage, ToolMessage, SystemMessage } from "../components/chat/ChatMessage";
import { Composer } from "../components/chat/Composer";
import { ChatDialogs } from "../components/chat/ChatDialogs";
import { basename, estimateTokenUsage, precedingUserIdx } from "../lib/chatUi";

export function ChatScreen() {
  const chatMessages = useChatMessages();
  const currentChat = useCurrentChat();
  const {
    chatPending,
    chatStreamingId,
    chatError,
    sendChat,
    cancelChat,
    server,
    flags,
    newChat,
    deleteChat,
    togglePinChat,
    renameChat,
    duplicateChat,
    setChatWorkspace,
    editMessage,
    deleteMessage,
    resendFromMessage,
    setChatError,
    reasoningEnabled,
    setReasoningEnabled,
    pendingToolApproval,
    approveTool,
    pendingUserChoice,
    answerUserChoice,
    modelInfo,
    workspaces,
  } = useAppStore(
    useShallow((s) => ({
      chatPending: s.chatPending,
      chatStreamingId: s.chatStreamingId,
      chatError: s.chatError,
      sendChat: s.sendChat,
      cancelChat: s.cancelChat,
      server: s.server,
      flags: s.flags,
      newChat: s.newChat,
      deleteChat: s.deleteChat,
      togglePinChat: s.togglePinChat,
      renameChat: s.renameChat,
      duplicateChat: s.duplicateChat,
      setChatWorkspace: s.setChatWorkspace,
      editMessage: s.editMessage,
      deleteMessage: s.deleteMessage,
      resendFromMessage: s.resendFromMessage,
      setChatError: s.setChatError,
      reasoningEnabled: s.reasoningEnabled,
      setReasoningEnabled: s.setReasoningEnabled,
      pendingToolApproval: s.pendingToolApproval,
      approveTool: s.approveTool,
      pendingUserChoice: s.pendingUserChoice,
      answerUserChoice: s.answerUserChoice,
      modelInfo: s.modelInfo,
      workspaces: s.settings.workspaces,
    })),
  );
  const [sideOpen, setSideOpen] = useState(true);
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
  const threadRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  // Mirror of atBottomRef for use in render. Scroll handler updates the ref
  // every event but only flips state when the threshold is actually crossed,
  // so we don't get a re-render per scroll pixel.
  const [atBottom, setAtBottom] = useState(true);

  // Ticking "now" used to display streaming elapsed seconds without calling
  // the impure Date.now() during render. Only ticks while a request is
  // pending; idle chats incur no interval cost. Every elapsed label (badges,
  // thinking card, streaming placeholder) derives from this, so one tick
  // re-renders them all.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!chatPending) return;
    const id = globalThis.setInterval(() => setNowTick(Date.now()), 250);
    return () => globalThis.clearInterval(id);
  }, [chatPending]);

  const { confirmElement, confirm } = useConfirm();

  const saveEdit = (idx: number, next: string) => {
    if (!currentChat) return;
    editMessage(currentChat.id, idx, next);
  };
  const onDelete = (idx: number) => {
    if (!currentChat) return;
    deleteMessage(currentChat.id, idx);
  };
  // Resend + regenerate both funnel through here. resendFromMessage truncates
  // everything after `idx`, so if any later message would be discarded, get
  // explicit confirmation first (see resendFromMessage in chatSlice.ts).
  const onResend = async (idx: number) => {
    if (!currentChat || chatPending) return;
    const laterCount = chatMessages.length - (idx + 1);
    if (laterCount >= 1) {
      const ok = await confirm({
        title: "Regenerate from here?",
        body: `This will remove the ${laterCount} later message${
          laterCount === 1 ? "" : "s"
        } in this chat.`,
        confirmLabel: "Continue",
        danger: true,
      });
      if (!ok) return;
    }
    resendFromMessage(currentChat.id, idx).catch(() => {});
  };
  // Retry the failed turn from its originating user message. Reuses the resend
  // machinery (which re-runs from, and truncates after, that message). No
  // confirm here — the user explicitly asked to retry, so discarding the failed
  // reply is the intent.
  const retryLastTurn = () => {
    if (!currentChat || chatPending) return;
    // precedingUserIdx searches backward from the given index; passing length
    // finds the last user message in the thread.
    const idx = precedingUserIdx(chatMessages, chatMessages.length);
    if (idx < 0) return;
    resendFromMessage(currentChat.id, idx).catch(() => {});
  };

  const openMenu = useContextMenu();
  const { promptElement, openPrompt } = useTextPrompt();

  const headerMenuItems = (): MenuItem[] => {
    if (!currentChat) return [{ label: "New chat", icon: "Plus", onClick: newChat }];
    const c = currentChat;
    return [
      {
        label: "Rename…",
        icon: "Pencil",
        onClick: () =>
          openPrompt({
            title: "Rename chat",
            initial: c.title,
            onSubmit: (v) => renameChat(c.id, v),
          }),
      },
      {
        label: c.pinned ? "Unpin" : "Pin",
        icon: "Pin",
        onClick: () => togglePinChat(c.id),
      },
      {
        label: "Duplicate",
        icon: "Copy",
        disabled: chatPending && chatStreamingId === c.id,
        onClick: () => duplicateChat(c.id),
      },
      {
        label: "Move to workspace",
        icon: "Layers",
        submenu: [
          {
            label: "All chats (none)",
            icon: c.workspace_id == null ? "Check" : undefined,
            disabled: c.workspace_id == null,
            onClick: () => setChatWorkspace(c.id, null),
          },
          ...workspaces.map(
            (w): MenuItem => ({
              label: w.name,
              icon: c.workspace_id === w.id ? "Check" : undefined,
              disabled: c.workspace_id === w.id,
              onClick: () => setChatWorkspace(c.id, w.id),
            }),
          ),
        ],
      },
      "separator",
      { label: "New chat", icon: "Plus", onClick: newChat },
      "separator",
      {
        label: "Delete chat…",
        icon: "Trash",
        danger: true,
        onClick: async () => {
          const ok = await confirm({
            title: `Delete "${c.title}"?`,
            confirmLabel: "Delete",
            danger: true,
          });
          if (ok) deleteChat(c.id);
        },
      },
    ];
  };

  // Menu for tool-result and stored-system messages, which have no .msg-tools
  // action row at all.
  const rawMessageMenuItems = (m: ChatMessageT, i: number): MenuItem[] => [
    {
      label: "Copy content",
      icon: "Copy",
      disabled: !m.content,
      onClick: () => copyText(m.content, String(i)),
    },
    "separator",
    {
      label: "Delete message",
      icon: "Trash",
      danger: true,
      disabled: chatPending,
      onClick: () => onDelete(i),
    },
  ];

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

  const modelName = flags.model ? basename(flags.model as string) : "no model";
  const canSend = server.ready && !!flags.model;

  // Fold the status-dot meaning into the model badge's tooltip so the colored
  // dot has a legend: ready (green) / loading (yellow) / stopped (muted).
  const modelStatusLabel = !server.running
    ? "server stopped"
    : server.ready
      ? "ready"
      : "loading model…";
  const modelBadgeTitle = `${modelName} — ${modelStatusLabel}`;

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

  // Page-head badge keeps showing the committed history token estimate.
  const ctxMax = typeof flags.ctx === "number" && flags.ctx > 0 ? flags.ctx : 4096;
  const tokenCount = estimateTokenUsage(chatMessages, "", ctxMax).historyTokens;

  return (
    <div className="chat-shell">
      <div className="chat-wrap">
        <div className="page-head" onContextMenu={(e) => openMenu(e, headerMenuItems())}>
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
            <span className="badge accent" title={modelBadgeTitle}>
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
              <span
                className="badge ghost"
                title="Speculative decoding: multi-token-prediction draft model"
              >
                <I.Spark size={11} /> MTP
              </span>
            )}
            {flags.spec_type === "draft-dflash" && (
              <span className="badge ghost" title="Speculative decoding: DFlash draft model">
                <I.Spark size={11} /> DFlash
              </span>
            )}
            {currentChat?.config?.workspace_root && (
              <span
                className="badge ghost"
                title={`Project folder: ${currentChat.config.workspace_root}`}
              >
                <I.Folder size={11} /> {basename(currentChat.config.workspace_root)}
              </span>
            )}
            {currentChat?.workspace_id &&
              (() => {
                const ws = workspaces.find((w) => w.id === currentChat.workspace_id);
                return ws ? (
                  <span className="badge ghost" title={`Workspace: ${ws.name}`}>
                    <I.Layers size={11} /> {ws.name}
                  </span>
                ) : null;
              })()}
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
                onClick={async () => {
                  const ok = await confirm({
                    title: `Delete "${currentChat.title}"?`,
                    confirmLabel: "Delete",
                    danger: true,
                  });
                  if (ok) deleteChat(currentChat.id);
                }}
              >
                <I.Trash size={12} />
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
            const key = `${currentChat?.id ?? "none"}-${i}`;
            if (m.role === "tool") {
              return <ToolMessage key={key} m={m} i={i} menuItems={rawMessageMenuItems} />;
            }
            if (m.role === "system") {
              return <SystemMessage key={key} m={m} i={i} menuItems={rawMessageMenuItems} />;
            }
            const isLast = i === chatMessages.length - 1;
            // Guard on chatStreamingId, not just chatPending: another chat
            // may be the one streaming while this one's last message is also
            // an assistant reply.
            const streaming =
              chatPending &&
              chatStreamingId === currentChat?.id &&
              isLast &&
              m.role === "assistant";
            const elapsedS = streaming ? (nowTick - m.time) / 1000 : 0;
            return (
              <ChatMessage
                key={key}
                m={m}
                i={i}
                modelName={modelName}
                streaming={streaming}
                elapsedS={elapsedS}
                chatPending={chatPending}
                serverReady={server.ready}
                actions={{
                  copyText,
                  copiedKey,
                  saveEdit,
                  onDelete,
                  onResend,
                  precedingUserIdx: (idx) => precedingUserIdx(chatMessages, idx),
                  cancelChat,
                }}
              />
            );
          })}

          {!atBottom && (
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
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 12px",
                background: "var(--red-soft)",
                border: "1px solid oklch(0.55 0.16 25 / 0.45)",
                borderRadius: "var(--radius)",
                color: "var(--red)",
                fontSize: 12.5,
              }}
            >
              <I.Info size={13} style={{ flexShrink: 0 }} />
              {/* Concise on-screen label — the detailed error stays in the
                  assistant bubble (chatSlice writes "⚠️ <error>") so it isn't
                  read twice; the full string is still available on hover. */}
              <span style={{ flex: 1, cursor: "help" }} title={chatError}>
                The last response ran into an error.
              </span>
              <button
                className="btn ghost"
                style={{ padding: "3px 8px", color: "var(--red)" }}
                onClick={retryLastTurn}
                disabled={chatPending || precedingUserIdx(chatMessages, chatMessages.length) < 0}
                title="Retry the last turn"
              >
                <I.Refresh size={11} /> Retry
              </button>
              <button
                className="btn ghost"
                style={{ padding: "3px 6px", color: "var(--red)" }}
                onClick={() => setChatError(null)}
                title="Dismiss"
              >
                <I.X size={12} />
              </button>
            </div>
          )}
        </div>

        <Composer
          chatId={currentChat?.id}
          canSend={canSend}
          chatPending={chatPending}
          server={server}
          onSend={(text, audio, image) => {
            sendChat(text, audio, image).catch(() => {});
          }}
          cancelChat={cancelChat}
          reasoningEnabled={reasoningEnabled}
          setReasoningEnabled={setReasoningEnabled}
          reasoningToggleActive={reasoningToggleActive}
          thinkingKnownUnsupported={thinkingKnownUnsupported}
          reasoningTitle={reasoningTitle}
          messages={chatMessages}
          ctxMax={ctxMax}
        />
      </div>
      <ChatSidebar open={sideOpen} onToggle={() => setSideOpen((o) => !o)} />
      {promptElement}
      {confirmElement}
      <ChatDialogs
        pendingToolApproval={pendingToolApproval}
        approveTool={approveTool}
        pendingUserChoice={pendingUserChoice}
        answerUserChoice={answerUserChoice}
      />
    </div>
  );
}
