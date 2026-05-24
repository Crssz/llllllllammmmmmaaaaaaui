import { useEffect, useRef, useState, type HTMLAttributes, type ReactElement } from "react";
import { Streamdown } from "streamdown";
import { I } from "../icons";
import type { Agency } from "../data";
import { useAppState } from "../state";
import { ChatSidebar } from "../components/ChatSidebar";

// Custom <pre> wrapper for code blocks: hides streamdown's built-in icons
// (we disable those via `controls={{ code: false }}` on the Streamdown root)
// and shows a hover-revealed Copy button instead.
function CodeBlockPre(props: HTMLAttributes<HTMLPreElement>) {
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
        window.setTimeout(() => setCopied(false), 1500);
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

function basename(p: string): string {
  if (!p) return "";
  const sep = p.includes("\\") ? "\\" : "/";
  return p.split(sep).pop() || p;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toTimeString().slice(0, 5);
}

export function ChatScreen({ agency }: { agency: Agency }) {
  const {
    chatMessages,
    chatPending,
    chatError,
    sendChat,
    cancelChat,
    server,
    flags,
    currentChat,
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
  } = useAppState();
  const [sideOpen, setSideOpen] = useState(true);
  const [draft, setDraft] = useState("");
  const [hiddenThink, setHiddenThink] = useState<Set<number>>(new Set());
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");
  // Tick state to drive elapsed-time labels while a request is in flight.
  const [phaseTick, setPhaseTick] = useState(0);
  useEffect(() => {
    if (!chatPending) return;
    const id = setInterval(() => setPhaseTick((t) => t + 1), 250);
    return () => clearInterval(id);
  }, [chatPending]);
  // Reference phaseTick so the linter doesn't strip it; it triggers re-renders
  // for the time-elapsed labels below.
  void phaseTick;
  // Tag is "<idx>" for message, "<idx>:think" for reasoning. Cleared after 1.5s.
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const copyText = (text: string, key: string) => {
    if (!text) return;
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopiedKey(key);
        window.setTimeout(() => {
          setCopiedKey((cur) => (cur === key ? null : cur));
        }, 1500);
      })
      .catch(() => {});
  };
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
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
    const id = window.setInterval(() => setNowTick(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [chatPending]);

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
    if (chatPending) return;
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    sendChat(text).catch(() => {});
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const modelName = flags.model ? basename(flags.model as string) : "no model";
  const canSend = server.ready && !!flags.model;

  // ── Token usage estimate ─────────────────────────────────────────────────
  // We don't ship a tokenizer in the UI, so this uses the standard 4-chars-
  // per-token heuristic plus a small role-tag overhead per message. Decent
  // for English; can be wired to llama-server's /tokenize later for accuracy.
  const approxTokens = (s: string) => Math.ceil((s?.length ?? 0) / 4);
  const ROLE_TAG_OVERHEAD = 4;
  const ctxMax = typeof flags.ctx === "number" && flags.ctx > 0 ? (flags.ctx as number) : 4096;
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
            <span className="badge accent">
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
              {modelName}
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
          <div className="composer-foot">
            <button
              className={"composer-chip" + (reasoningEnabled ? " toggled" : "")}
              onClick={() => setReasoningEnabled(!reasoningEnabled)}
              title={
                flags.jinja
                  ? `Toggle 'enable_thinking' in chat_template_kwargs. Currently ${
                      reasoningEnabled ? "on" : "off"
                    }.`
                  : "Enable --jinja in Configure → Templates for this toggle to take effect."
              }
              style={flags.jinja ? undefined : { opacity: 0.6 }}
            >
              <I.Brain size={11} /> Reasoning · {reasoningEnabled ? "on" : "off"}
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
                  title={canSend ? "Send" : "Server / model not ready"}
                  onClick={submit}
                  disabled={!canSend || !draft.trim()}
                  style={{ opacity: canSend && draft.trim() ? 1 : 0.5 }}
                >
                  <I.Send size={13} />
                </button>
              </>
            )}
          </div>
        </div>
      </div>
      <ChatSidebar open={sideOpen} onToggle={() => setSideOpen((o) => !o)} />
      {pendingToolApproval && (
        <div
          className="tool-approval-overlay"
          onClick={() => approveTool(pendingToolApproval.id, "deny")}
        >
          <div className="tool-approval-card" onClick={(e) => e.stopPropagation()}>
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
          </div>
        </div>
      )}
    </div>
  );
}

function ApprovalFooter({
  onDecide,
}: {
  onDecide: (decision: "allow" | "deny", remember: boolean) => void;
}) {
  const [remember, setRemember] = useState(false);
  return (
    <div className="tool-approval-foot">
      <label className="mcp-check" style={{ marginRight: "auto" }}>
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
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
