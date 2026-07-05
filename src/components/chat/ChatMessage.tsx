import { useState } from "react";
import { Streamdown } from "streamdown";
import { I } from "../../icons";
import { useContextMenu, type MenuItem } from "../ContextMenu";
import type { ChatMessage as ChatMessageType } from "../../state";
import { STREAMDOWN_COMPONENTS } from "./CodeBlockPre";
import { MessageAudio } from "./MessageAudio";
import { MessageImage } from "./MessageImage";
import { fmtTime, streamingPhase } from "../../lib/chatUi";

// Callbacks the message row needs from the screen. All chat-level actions
// (edit/delete/resend/stop) live in the store or the parent; the message row
// owns only its own transient UI state (copied-flash, reasoning show/hide,
// in-place editing).
type MessageActions = {
  copyText: (text: string, key: string) => void;
  copiedKey: string | null;
  saveEdit: (idx: number, next: string) => void;
  onDelete: (idx: number) => void;
  onResend: (idx: number) => void;
  precedingUserIdx: (idx: number) => number;
  cancelChat: () => void;
};

// A tool-result row (role === "tool"): raw content in a <pre>, minimal menu.
export function ToolMessage({
  m,
  i,
  menuItems,
}: Readonly<{
  m: ChatMessageType;
  i: number;
  menuItems: (m: ChatMessageType, i: number) => MenuItem[];
}>) {
  const openMenu = useContextMenu();
  return (
    <div className="msg tool-msg" onContextMenu={(e) => openMenu(e, menuItems(m, i))}>
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

// A stored system-prompt row (role === "system").
export function SystemMessage({
  m,
  i,
  menuItems,
}: Readonly<{
  m: ChatMessageType;
  i: number;
  menuItems: (m: ChatMessageType, i: number) => MenuItem[];
}>) {
  const openMenu = useContextMenu();
  return (
    <div className="msg system-msg" onContextMenu={(e) => openMenu(e, menuItems(m, i))}>
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

// A user/assistant message row: head (role/time/phase/tps), reasoning card,
// in-place edit, body (Streamdown or streaming placeholder), attachments,
// tool-calls block, and the action row. Owns local UI state so switching
// chats (which remounts via the keyed message list) resets it naturally.
export function ChatMessage({
  m,
  i,
  modelName,
  streaming,
  elapsedS,
  chatPending,
  serverReady,
  actions,
}: Readonly<{
  m: ChatMessageType;
  i: number;
  modelName: string;
  streaming: boolean;
  elapsedS: number;
  chatPending: boolean;
  serverReady: boolean;
  actions: MessageActions;
}>) {
  const openMenu = useContextMenu();
  const [hidden, setHidden] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState("");

  const { copyText, copiedKey, saveEdit, onDelete, onResend, precedingUserIdx, cancelChat } =
    actions;

  const reasoning = m.reasoning?.trim();
  const showReasoning = !!reasoning && !hidden;
  const thinkingOnly = streaming && !m.content && reasoning;
  const canActOnMessage = !streaming && !editing;
  // Phase derivation while streaming (null when not streaming).
  const phase = streaming ? streamingPhase(!!m.content, !!reasoning) : null;

  const startEdit = () => {
    setEditing(true);
    setEditDraft(m.content);
  };
  const cancelEdit = () => {
    setEditing(false);
    setEditDraft("");
  };
  const commitEdit = () => {
    saveEdit(i, editDraft);
    setEditing(false);
    setEditDraft("");
  };
  const doDelete = () => {
    onDelete(i);
    if (editing) cancelEdit();
  };
  const toggleHidden = () => setHidden((h) => !h);

  const menuItems = (): MenuItem[] => {
    if (streaming) {
      return [{ label: "Stop generating", icon: "Stop", onClick: cancelChat }];
    }
    const items: MenuItem[] = [
      {
        label: "Copy message",
        icon: "Copy",
        disabled: !m.content,
        onClick: () => copyText(m.content, String(i)),
      },
    ];
    if (reasoning) {
      items.push(
        {
          label: "Copy reasoning",
          icon: "Brain",
          onClick: () => copyText(reasoning, `${i}:think`),
        },
        {
          label: hidden ? "Show reasoning" : "Hide reasoning",
          icon: "Brain",
          onClick: toggleHidden,
        },
      );
    }
    items.push("separator");
    if (m.role === "user") {
      items.push({
        label: "Resend from here",
        icon: "Refresh",
        disabled: chatPending || !serverReady,
        onClick: () => onResend(i),
      });
    } else {
      items.push({
        label: "Regenerate response",
        icon: "Refresh",
        disabled: chatPending || !serverReady || precedingUserIdx(i) < 0,
        onClick: () => onResend(precedingUserIdx(i)),
      });
    }
    items.push(
      {
        label: "Edit message",
        icon: "Pencil",
        disabled: chatPending,
        onClick: startEdit,
      },
      "separator",
      {
        label: "Delete message",
        icon: "Trash",
        danger: true,
        disabled: chatPending,
        onClick: doDelete,
      },
    );
    return items;
  };

  return (
    <div
      className={"msg " + (m.role === "user" ? "user" : "model")}
      onContextMenu={(e) => openMenu(e, menuItems())}
    >
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
              onClick={toggleHidden}
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

      {editing ? (
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
                commitEdit();
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
              <span className="kbd">⌘↵</span> save · <span className="kbd">esc</span> cancel
            </span>
            <button className="btn ghost" onClick={cancelEdit}>
              Cancel
            </button>
            <button className="btn primary" onClick={commitEdit}>
              <I.Check size={11} /> Save
            </button>
          </div>
        </div>
      ) : (
        (m.content || (streaming && !reasoning)) && (
          <div
            className={
              "msg-body" + (m.role === "assistant" ? " md-output md-bubble" : " md-output")
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
              disabled={chatPending || !serverReady}
              title="Resend (regenerates from this point)"
            >
              <I.Refresh size={11} /> Resend
            </button>
          )}
          <button
            className="btn ghost"
            style={{ padding: "3px 8px" }}
            onClick={startEdit}
            disabled={chatPending}
            title="Edit message"
          >
            <I.Sliders size={11} /> Edit
          </button>
          <button
            className="btn ghost"
            style={{ padding: "3px 8px", color: "var(--red)" }}
            onClick={doDelete}
            disabled={chatPending}
            title="Delete message"
          >
            <I.X size={11} /> Delete
          </button>
        </div>
      )}
    </div>
  );
}
