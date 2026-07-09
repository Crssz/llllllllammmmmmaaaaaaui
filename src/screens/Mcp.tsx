import { useEffect, useId, useMemo, useState } from "react";
import { I } from "../icons";
import { useAppStore } from "../state";
import { useShallow } from "zustand/react/shallow";
import type { McpServerConfig, McpStatus, McpTool, McpTransport } from "../lib/api";
import { useContextMenu, type MenuItem } from "../components/ContextMenu";
import { useTextPrompt } from "../components/TextPromptDialog";
import { useConfirm } from "../components/ConfirmDialog";

function emptyServer(): McpServerConfig {
  return {
    id: `mcp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: "New MCP server",
    transport: "stdio",
    command: "",
    args: [],
    env: {},
    cwd: null,
    url: null,
    headers: {},
    enabled: true,
    autostart: false,
  };
}

function StatusBadge({ status }: Readonly<{ status: McpStatus | undefined }>) {
  if (!status) {
    return (
      <span className="badge ghost">
        <span className="dot" style={{ background: "var(--muted)" }} /> idle
      </span>
    );
  }
  if (status.connected) {
    return (
      <span className="badge green">
        <span className="dot" /> connected · {status.tool_count} tool
        {status.tool_count === 1 ? "" : "s"}
      </span>
    );
  }
  if (status.error) {
    return (
      <span className="badge red" title={status.error}>
        <span className="dot" /> error
      </span>
    );
  }
  return (
    <span className="badge ghost">
      <span className="dot" style={{ background: "var(--muted)" }} /> disconnected
    </span>
  );
}

function ToolList({ tools }: Readonly<{ tools: McpTool[] | undefined }>) {
  if (!tools || tools.length === 0) {
    return (
      <div style={{ color: "var(--muted)", fontStyle: "italic", fontSize: 12.5, padding: "8px 0" }}>
        No tools — connect the server to fetch its catalog.
      </div>
    );
  }
  return (
    <div className="mcp-tool-list">
      {tools.map((t) => (
        <div key={t.name} className="mcp-tool-row">
          <div className="mono" style={{ fontWeight: 500, color: "var(--text)" }}>
            {t.name}
          </div>
          {t.description && (
            <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>{t.description}</div>
          )}
        </div>
      ))}
    </div>
  );
}

function KvEditor({
  label,
  value,
  onChange,
  placeholderKey,
  placeholderValue,
}: Readonly<{
  label: string;
  value: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
  placeholderKey: string;
  placeholderValue: string;
}>) {
  const entries = Object.entries(value);
  const update = (idx: number, k: string, v: string) => {
    const arr = [...entries];
    arr[idx] = [k, v];
    const out: Record<string, string> = {};
    for (const [kk, vv] of arr) {
      if (kk) out[kk] = vv;
    }
    onChange(out);
  };
  const remove = (idx: number) => {
    const arr = entries.filter((_, i) => i !== idx);
    const out: Record<string, string> = {};
    for (const [kk, vv] of arr) out[kk] = vv;
    onChange(out);
  };
  const add = () => {
    onChange({ ...value, "": "" });
  };
  return (
    <div className="mcp-kv-block">
      <div className="mcp-kv-head">
        <span>{label}</span>
        <button className="btn ghost" onClick={add} title={`Add ${label.toLowerCase()}`}>
          <I.Plus size={11} /> Add
        </button>
      </div>
      {entries.length === 0 && (
        <div style={{ fontSize: 12, color: "var(--muted)", fontStyle: "italic" }}>(none)</div>
      )}
      {entries.map(([k, v], i) => (
        <div key={i} className="mcp-kv-row">
          <input
            className="input mono"
            placeholder={placeholderKey}
            value={k}
            onChange={(e) => update(i, e.target.value, v)}
          />
          <input
            className="input mono"
            placeholder={placeholderValue}
            value={v}
            onChange={(e) => update(i, k, e.target.value)}
          />
          <button className="btn ghost" onClick={() => remove(i)} title="Remove">
            <I.X size={11} />
          </button>
        </div>
      ))}
    </div>
  );
}

function ServerEditor({
  draft,
  onChange,
}: Readonly<{
  draft: McpServerConfig;
  onChange: (next: McpServerConfig) => void;
}>) {
  const patch = (p: Partial<McpServerConfig>) => onChange({ ...draft, ...p });
  const argsString = (draft.args ?? []).join("\n");
  const uid = useId();
  const fid = (name: string) => `${uid}-${name}`;
  return (
    <div className="mcp-editor">
      <div className="mcp-field">
        <label htmlFor={fid("name")}>Name</label>
        <input
          id={fid("name")}
          className="input"
          value={draft.name}
          onChange={(e) => patch({ name: e.target.value })}
        />
      </div>
      <div className="mcp-field">
        <label htmlFor={fid("transport")}>Transport</label>
        <select
          id={fid("transport")}
          className="select mono"
          value={draft.transport}
          onChange={(e) => patch({ transport: e.target.value as McpTransport })}
        >
          <option value="stdio">stdio (spawn process)</option>
          <option value="http">http (JSON-RPC over HTTP)</option>
          <option value="sse">sse (Streamable HTTP / SSE)</option>
        </select>
      </div>

      {draft.transport === "stdio" ? (
        <>
          <div className="mcp-field">
            <label htmlFor={fid("command")}>Command</label>
            <input
              id={fid("command")}
              className="input mono"
              placeholder="e.g. npx or python or /path/to/server"
              value={draft.command ?? ""}
              onChange={(e) => patch({ command: e.target.value })}
            />
          </div>
          <div className="mcp-field">
            <label htmlFor={fid("args")}>
              Arguments (newline or space separated; quote args containing spaces)
            </label>
            <textarea
              id={fid("args")}
              className="input mono"
              rows={Math.max(3, (draft.args?.length ?? 0) + 1)}
              placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/some/path"}
              value={argsString}
              onChange={(e) =>
                patch({
                  args: e.target.value
                    .split("\n")
                    .map((s) => s.trim())
                    .filter((s) => s.length > 0),
                })
              }
              style={{ resize: "vertical" }}
            />
          </div>
          <div className="mcp-field">
            <label htmlFor={fid("cwd")}>Working directory (optional)</label>
            <input
              id={fid("cwd")}
              className="input mono"
              placeholder="(inherits app cwd)"
              value={draft.cwd ?? ""}
              onChange={(e) => patch({ cwd: e.target.value || null })}
            />
          </div>
          <KvEditor
            label="Environment variables"
            value={draft.env ?? {}}
            onChange={(env) => patch({ env })}
            placeholderKey="NAME"
            placeholderValue="value"
          />
        </>
      ) : (
        <>
          <div className="mcp-field">
            <label htmlFor={fid("url")}>URL</label>
            <input
              id={fid("url")}
              className="input mono"
              placeholder="https://example.com/mcp"
              value={draft.url ?? ""}
              onChange={(e) => patch({ url: e.target.value })}
            />
          </div>
          <KvEditor
            label="Headers"
            value={draft.headers ?? {}}
            onChange={(headers) => patch({ headers })}
            placeholderKey="Authorization"
            placeholderValue="Bearer ..."
          />
        </>
      )}

      <div className="mcp-field-row">
        <label className="mcp-check">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
          />{" "}
          Enabled (eligible for chat sessions)
        </label>
        <label className="mcp-check">
          <input
            type="checkbox"
            checked={draft.autostart}
            onChange={(e) => patch({ autostart: e.target.checked })}
          />{" "}
          Connect automatically on app start
        </label>
      </div>
    </div>
  );
}

export function McpScreen() {
  const {
    mcpServers,
    mcpStatuses,
    mcpTools,
    mcpUpsertServer,
    mcpDeleteServer,
    mcpConnect,
    mcpDisconnect,
    mcpRefreshStatus,
  } = useAppStore(
    useShallow((s) => ({
      mcpServers: s.settings.mcp_servers,
      mcpStatuses: s.mcpStatuses,
      mcpTools: s.mcpTools,
      mcpUpsertServer: s.mcpUpsertServer,
      mcpDeleteServer: s.mcpDeleteServer,
      mcpConnect: s.mcpConnect,
      mcpDisconnect: s.mcpDisconnect,
      mcpRefreshStatus: s.mcpRefreshStatus,
    })),
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<McpServerConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // On mount, refresh statuses once.
  useEffect(() => {
    mcpRefreshStatus().catch(() => {});
  }, [mcpRefreshStatus]);

  // When the selection changes, hydrate the draft from the persisted config.
  useEffect(() => {
    if (!selectedId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDraft(null);
      return;
    }
    const found = mcpServers.find((s) => s.id === selectedId);
    if (found) setDraft({ ...found });
  }, [selectedId, mcpServers]);

  // Auto-select the first server on first render if any exist.
  useEffect(() => {
    if (selectedId == null && mcpServers.length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedId(mcpServers[0].id);
    }
  }, [selectedId, mcpServers]);

  const dirty = useMemo(() => {
    if (!draft || !selectedId) return false;
    const persisted = mcpServers.find((s) => s.id === selectedId);
    if (!persisted) return true; // new server
    return JSON.stringify(persisted) !== JSON.stringify(draft);
  }, [draft, selectedId, mcpServers]);

  const { confirmElement, confirm } = useConfirm();

  const onAdd = () => {
    const fresh = emptyServer();
    setDraft(fresh);
    setSelectedId(fresh.id);
  };

  const onSave = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await mcpUpsertServer(draft);
    } finally {
      setSaving(false);
    }
  };

  // Switching the sidebar selection while the current draft has unsaved edits
  // used to discard them silently. Guard with a confirmation before hydrating
  // the new draft over the old one.
  const selectServer = async (id: string) => {
    if (id === selectedId) return;
    if (
      dirty &&
      !(await confirm({
        title: "Discard unsaved changes?",
        body: "Your edits to this server haven't been saved.",
        confirmLabel: "Discard",
        danger: true,
      }))
    ) {
      return;
    }
    setSelectedId(id);
  };

  const onDelete = async () => {
    if (!selectedId || !draft) return;
    if (
      !(await confirm({
        title: `Delete MCP server "${draft.name}"?`,
        confirmLabel: "Delete",
        danger: true,
      }))
    ) {
      return;
    }
    await mcpDeleteServer(selectedId);
    setSelectedId(null);
    setDraft(null);
  };

  const onConnect = async () => {
    if (!selectedId) return;
    setBusyId(selectedId);
    try {
      // Save first so the backend sees the latest config.
      if (draft && dirty) await mcpUpsertServer(draft);
      await mcpConnect(selectedId);
    } catch {
      // mcpConnect already writes the failure into mcpStatuses[id].error,
      // which the styled error box in the detail header surfaces.
    } finally {
      setBusyId(null);
    }
  };

  const onDisconnect = async () => {
    if (!selectedId) return;
    setBusyId(selectedId);
    try {
      await mcpDisconnect(selectedId);
    } finally {
      setBusyId(null);
    }
  };

  const openMenu = useContextMenu();
  const { promptElement, openPrompt } = useTextPrompt();

  // Row-targeted variants of the header actions: they act on the clicked
  // server (not the selection) and skip the dirty-draft save, which only
  // applies to the selected server's editor.
  const connectServer = async (id: string) => {
    setBusyId(id);
    try {
      await mcpConnect(id);
    } catch {
      // mcpConnect already writes the failure into mcpStatuses[id].error.
    } finally {
      setBusyId(null);
    }
  };

  const deleteServer = async (s: McpServerConfig) => {
    if (
      !(await confirm({
        title: `Delete MCP server "${s.name}"?`,
        confirmLabel: "Delete",
        danger: true,
      }))
    ) {
      return;
    }
    await mcpDeleteServer(s.id);
    if (selectedId === s.id) {
      setSelectedId(null);
      setDraft(null);
    }
  };

  const serverMenuItems = (s: McpServerConfig): MenuItem[] => {
    const st = mcpStatuses[s.id];
    return [
      st?.connected
        ? {
            label: "Disconnect",
            icon: "Eject",
            disabled: busyId === s.id,
            onClick: () => mcpDisconnect(s.id).catch(() => {}),
          }
        : {
            label: "Connect",
            icon: "Bolt",
            disabled: busyId === s.id,
            onClick: () => connectServer(s.id).catch(() => {}),
          },
      "separator",
      {
        label: "Rename…",
        icon: "Pencil",
        onClick: () =>
          openPrompt({
            title: "Rename MCP server",
            initial: s.name,
            onSubmit: (v) => mcpUpsertServer({ ...s, name: v }).catch(() => {}),
          }),
      },
      {
        label: s.enabled ? "Disable" : "Enable",
        icon: s.enabled ? "X" : "Check",
        onClick: () => mcpUpsertServer({ ...s, enabled: !s.enabled }).catch(() => {}),
      },
      {
        label: s.autostart ? "Autostart: on" : "Autostart: off",
        icon: s.autostart ? "Check" : undefined,
        hint: "toggle",
        onClick: () => mcpUpsertServer({ ...s, autostart: !s.autostart }).catch(() => {}),
      },
      {
        label: "Duplicate",
        icon: "Copy",
        onClick: () =>
          mcpUpsertServer({ ...s, id: emptyServer().id, name: `${s.name} copy` }).catch(() => {}),
      },
      "separator",
      {
        label: "Delete…",
        icon: "Trash",
        danger: true,
        onClick: () => deleteServer(s).catch(() => {}),
      },
    ];
  };

  const status = selectedId ? mcpStatuses[selectedId] : undefined;
  const tools = selectedId ? mcpTools[selectedId] : undefined;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="crumb">Tools / MCP</div>
          <h1>Model Context Protocol servers</h1>
        </div>
        <div className="head-meta">
          <button
            className="btn ghost"
            onClick={() => mcpRefreshStatus().catch(() => {})}
            title="Refresh connection statuses"
          >
            <I.Refresh size={12} /> Refresh
          </button>
          <button className="btn primary" onClick={onAdd}>
            <I.Plus size={12} /> Add server
          </button>
        </div>
      </div>

      <div className="mcp-layout">
        <aside className="mcp-sidebar">
          {mcpServers.length === 0 && (
            <div className="mcp-empty">
              <I.Globe size={20} style={{ color: "var(--accent)" }} />
              <div>
                <div style={{ color: "var(--text)", marginBottom: 4 }}>No MCP servers yet</div>
                <div style={{ fontSize: 12, color: "var(--muted)" }}>
                  Add a server to expose tools (filesystem, web search, git, custom integrations…)
                  to the chat.
                </div>
              </div>
            </div>
          )}
          {mcpServers.map((s) => {
            const st = mcpStatuses[s.id];
            const active = selectedId === s.id;
            return (
              <button
                key={s.id}
                className={"mcp-sidebar-item" + (active ? " active" : "")}
                onClick={() => {
                  selectServer(s.id).catch(() => {});
                }}
                onContextMenu={(e) => {
                  // Select the row so the detail pane matches the menu target
                  // — but never at the cost of clobbering an unsaved draft on
                  // another server (the hydration effect would wipe it).
                  if (!dirty || selectedId === s.id) setSelectedId(s.id);
                  openMenu(e, serverMenuItems(s));
                }}
              >
                <span
                  className="dot"
                  style={{
                    background: st?.connected
                      ? "var(--green)"
                      : st?.error
                        ? "var(--red)"
                        : "var(--muted)",
                    boxShadow: st?.connected ? "0 0 6px var(--green)" : "none",
                  }}
                />
                <div style={{ overflow: "hidden", flex: 1 }}>
                  <div className="mcp-sidebar-name">{s.name}</div>
                  <div className="mcp-sidebar-meta mono">
                    {s.transport}
                    {st?.connected ? ` · ${st.tool_count} tools` : ""}
                  </div>
                </div>
              </button>
            );
          })}
        </aside>

        <section className="mcp-detail">
          {!draft ? (
            <div
              style={{
                margin: "auto",
                color: "var(--muted)",
                textAlign: "center",
                padding: "40px 20px",
              }}
            >
              <I.Globe size={32} style={{ color: "var(--accent)", marginBottom: 10 }} />
              <div>Select a server to edit, or click &ldquo;Add server&rdquo; to create one.</div>
            </div>
          ) : (
            <>
              <div className="mcp-detail-head">
                <div>
                  <div className="mcp-detail-title">{draft.name}</div>
                  <div style={{ marginTop: 6 }}>
                    <StatusBadge status={status} />
                  </div>
                  {status?.error && (
                    <div
                      style={{
                        marginTop: 8,
                        padding: "8px 10px",
                        background: "var(--red-soft)",
                        border: "1px solid oklch(0.55 0.16 25 / 0.45)",
                        borderRadius: "var(--radius)",
                        color: "var(--red)",
                        fontSize: 12,
                      }}
                    >
                      <I.Info size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
                      {status.error}
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  {status?.connected ? (
                    <button
                      className="btn"
                      onClick={onDisconnect}
                      disabled={busyId === selectedId}
                      title="Disconnect"
                    >
                      <I.Stop size={11} /> Disconnect
                    </button>
                  ) : (
                    <button
                      className="btn primary"
                      onClick={onConnect}
                      disabled={busyId === selectedId}
                      title="Connect and load tools"
                    >
                      <I.Play size={11} /> {busyId === selectedId ? "Connecting…" : "Connect"}
                    </button>
                  )}
                  <button
                    className="btn"
                    onClick={onSave}
                    disabled={!dirty || saving}
                    title={dirty ? "Save changes" : "No changes to save"}
                  >
                    <I.Check size={11} /> {saving ? "Saving…" : dirty ? "Save" : "Saved"}
                  </button>
                  <button
                    className="btn"
                    onClick={onDelete}
                    style={{ color: "var(--red)" }}
                    title="Delete server"
                  >
                    <I.X size={11} />
                  </button>
                </div>
              </div>

              <ServerEditor draft={draft} onChange={setDraft} />

              <div className="mcp-tools-section">
                <div className="mcp-tools-head">
                  <I.Sliders size={13} />
                  <span>Available tools</span>
                </div>
                <ToolList tools={tools} />
              </div>
            </>
          )}
        </section>
      </div>
      {promptElement}
      {confirmElement}
    </>
  );
}
