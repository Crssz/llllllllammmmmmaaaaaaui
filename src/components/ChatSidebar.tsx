import { useMemo, useState } from "react";
import { I } from "../icons";
import { useAppStore, useCurrentChat } from "../state";
import { useShallow } from "zustand/react/shallow";
import { defaultSessionConfig, type ChatSessionConfig, type ToolPermission } from "../lib/api";

function Section({
  title,
  icon,
  children,
  defaultOpen = true,
}: Readonly<{
  title: string;
  icon: keyof typeof I;
  children: React.ReactNode;
  defaultOpen?: boolean;
}>) {
  const [open, setOpen] = useState(defaultOpen);
  const IconCmp = I[icon];
  return (
    <div className={"chat-side-section" + (open ? "" : " collapsed")}>
      <button className="chat-side-section-head" onClick={() => setOpen((o) => !o)}>
        <IconCmp size={12} />
        <span>{title}</span>
        <I.Chevron
          size={11}
          style={{
            marginLeft: "auto",
            transform: open ? "rotate(0)" : "rotate(-90deg)",
            transition: "transform 0.15s",
          }}
        />
      </button>
      {open && <div className="chat-side-section-body">{children}</div>}
    </div>
  );
}

function ToolPermSelect({
  value,
  onChange,
  compact = false,
}: Readonly<{
  value: ToolPermission;
  onChange: (v: ToolPermission) => void;
  compact?: boolean;
}>) {
  return (
    <select
      className="select mono"
      value={value}
      onChange={(e) => onChange(e.target.value as ToolPermission)}
      style={compact ? { padding: "1px 4px", fontSize: 11 } : undefined}
    >
      <option value="allow">allow</option>
      <option value="ask">ask</option>
      <option value="deny">deny</option>
    </select>
  );
}

export function ChatSidebar({ open, onToggle }: Readonly<{ open: boolean; onToggle: () => void }>) {
  const currentChat = useCurrentChat();
  const {
    updateSessionConfig,
    settings,
    mcpServers,
    mcpStatuses,
    mcpTools,
    applyPresetToSession,
    saveSessionAsPreset,
    deletePreset,
  } = useAppStore(
    useShallow((s) => ({
      updateSessionConfig: s.updateSessionConfig,
      settings: s.settings,
      mcpServers: s.settings.mcp_servers,
      mcpStatuses: s.mcpStatuses,
      mcpTools: s.mcpTools,
      applyPresetToSession: s.applyPresetToSession,
      saveSessionAsPreset: s.saveSessionAsPreset,
      deletePreset: s.deletePreset,
    })),
  );

  const [newPresetName, setNewPresetName] = useState("");
  const [savingPreset, setSavingPreset] = useState(false);

  const cfg: ChatSessionConfig = useMemo(
    () => currentChat?.config ?? defaultSessionConfig(),
    [currentChat],
  );

  if (!open) {
    return (
      <button className="chat-side-collapsed" onClick={onToggle} title="Show session controls">
        <I.Sliders size={13} />
      </button>
    );
  }

  if (!currentChat) {
    return (
      <aside className="chat-side">
        <div className="chat-side-head">
          <I.Sliders size={13} />
          <span>Session</span>
          <button
            className="iconbtn"
            onClick={onToggle}
            title="Hide session controls"
            style={{ marginLeft: "auto", width: 22, height: 22 }}
          >
            <I.X size={11} />
          </button>
        </div>
        <div style={{ padding: 14, color: "var(--muted)", fontSize: 12.5 }}>
          Start or pick a chat to configure session-specific settings.
        </div>
      </aside>
    );
  }

  const update = (patch: Partial<ChatSessionConfig>) => updateSessionConfig(currentChat.id, patch);

  const toggleMcp = (serverId: string, on: boolean) => {
    const cur = new Set(cfg.mcp_server_ids);
    if (on) cur.add(serverId);
    else cur.delete(serverId);
    update({ mcp_server_ids: Array.from(cur) });
  };

  const setToolPolicy = (key: string, policy: ToolPermission) => {
    const per_tool = { ...cfg.tool_permissions.per_tool, [key]: policy };
    update({ tool_permissions: { ...cfg.tool_permissions, per_tool } });
  };

  const clearToolPolicy = (key: string) => {
    const per_tool = { ...cfg.tool_permissions.per_tool };
    delete per_tool[key];
    update({ tool_permissions: { ...cfg.tool_permissions, per_tool } });
  };

  const onSavePreset = async () => {
    const name = newPresetName.trim();
    if (!name) return;
    setSavingPreset(true);
    try {
      await saveSessionAsPreset(currentChat.id, name);
      setNewPresetName("");
    } finally {
      setSavingPreset(false);
    }
  };

  const onApplyPreset = (id: string) => {
    if (!id) return;
    if (
      cfg.system_prompt ||
      cfg.chat_template ||
      cfg.mcp_server_ids.length > 0 ||
      Object.keys(cfg.tool_permissions.per_tool).length > 0
    ) {
      if (!confirm("Replace this session's current config with the preset?")) return;
    }
    applyPresetToSession(currentChat.id, id);
  };

  return (
    <aside className="chat-side">
      <div className="chat-side-head">
        <I.Sliders size={13} />
        <span>Session controls</span>
        <button
          className="iconbtn"
          onClick={onToggle}
          title="Hide session controls"
          style={{ marginLeft: "auto", width: 22, height: 22 }}
        >
          <I.X size={11} />
        </button>
      </div>

      <Section title="Preset" icon="Bookmark">
        <select
          className="select mono"
          value={cfg.preset_id ?? ""}
          onChange={(e) => onApplyPreset(e.target.value)}
        >
          <option value="">(no preset)</option>
          {settings.chat_presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {cfg.preset_id && (
          <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 4 }}>
            Linked to preset. Editing fields below diverges from the saved copy.
          </div>
        )}
        <div className="chat-side-row" style={{ marginTop: 8 }}>
          <input
            className="input"
            placeholder="New preset name…"
            value={newPresetName}
            onChange={(e) => setNewPresetName(e.target.value)}
          />
          <button
            className="btn primary"
            disabled={!newPresetName.trim() || savingPreset}
            onClick={onSavePreset}
          >
            <I.Plus size={11} /> Save
          </button>
        </div>
        {cfg.preset_id && (
          <button
            className="btn ghost"
            style={{ marginTop: 6, color: "var(--red)" }}
            onClick={async () => {
              if (!cfg.preset_id) return;
              if (!confirm("Delete this preset?")) return;
              await deletePreset(cfg.preset_id);
              update({ preset_id: null });
            }}
          >
            <I.X size={11} /> Delete linked preset
          </button>
        )}
      </Section>

      <Section title="System prompt" icon="Brain">
        <textarea
          className="input"
          placeholder="You are a helpful assistant…"
          value={cfg.system_prompt ?? ""}
          onChange={(e) => update({ system_prompt: e.target.value || null })}
          rows={5}
          style={{ resize: "vertical", fontFamily: "inherit" }}
        />
      </Section>

      <Section title="Chat template" icon="Terminal" defaultOpen={false}>
        <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 6 }}>
          Optional Jinja template override sent as <span className="mono">chat_template</span> on
          each request. Leave blank to use the model default.
        </div>
        <textarea
          className="input mono"
          placeholder="{% for m in messages %}…{% endfor %}"
          value={cfg.chat_template ?? ""}
          onChange={(e) => update({ chat_template: e.target.value || null })}
          rows={6}
          style={{ resize: "vertical", fontSize: 11.5 }}
        />
      </Section>

      <Section title="MCP servers" icon="Globe">
        {mcpServers.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--muted)", fontStyle: "italic" }}>
            No MCP servers registered. Add one on the MCP tab.
          </div>
        ) : (
          mcpServers.map((s) => {
            const enabled = cfg.mcp_server_ids.includes(s.id);
            const st = mcpStatuses[s.id];
            return (
              <label key={s.id} className="chat-side-mcp">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => toggleMcp(s.id, e.target.checked)}
                />
                <span
                  className="dot"
                  style={{
                    background: st?.connected
                      ? "var(--green)"
                      : st?.error
                        ? "var(--red)"
                        : "var(--muted)",
                  }}
                />
                <span style={{ flex: 1, color: "var(--text)" }}>{s.name}</span>
                <span className="mono" style={{ fontSize: 11, color: "var(--subtle)" }}>
                  {st?.connected ? `${st.tool_count}t` : "off"}
                </span>
              </label>
            );
          })
        )}
      </Section>

      <Section title="Tool permissions" icon="Lock">
        <div className="chat-side-row">
          <span style={{ fontSize: 12, color: "var(--muted)" }}>Default policy</span>
          <ToolPermSelect
            value={cfg.tool_permissions.default}
            onChange={(v) => update({ tool_permissions: { ...cfg.tool_permissions, default: v } })}
          />
        </div>
        <div
          style={{
            marginTop: 10,
            fontSize: 11.5,
            color: "var(--subtle)",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          Per-tool overrides
        </div>
        {cfg.mcp_server_ids.flatMap((sid) => {
          const tools = mcpTools[sid] ?? [];
          const server = mcpServers.find((s) => s.id === sid);
          if (!server) return [];
          if (tools.length === 0)
            return [
              <div key={`${sid}-empty`} style={{ fontSize: 11.5, color: "var(--muted)" }}>
                {server.name}: connect to see tools
              </div>,
            ];
          return tools.map((t) => {
            const key = `${sid}:${t.name}`;
            const policy = cfg.tool_permissions.per_tool[key];
            return (
              <div key={key} className="chat-side-tool-perm">
                <div style={{ overflow: "hidden", flex: 1 }}>
                  <div
                    className="mono"
                    style={{
                      fontSize: 11.5,
                      color: "var(--text-2)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                    title={t.name}
                  >
                    {t.name}
                  </div>
                  <div style={{ fontSize: 10.5, color: "var(--subtle)" }}>{server.name}</div>
                </div>
                <ToolPermSelect
                  value={policy ?? cfg.tool_permissions.default}
                  onChange={(v) => setToolPolicy(key, v)}
                  compact
                />
                {policy && (
                  <button
                    className="iconbtn"
                    title="Clear override (use default)"
                    onClick={() => clearToolPolicy(key)}
                    style={{ width: 18, height: 18 }}
                  >
                    <I.X size={10} />
                  </button>
                )}
              </div>
            );
          });
        })}
      </Section>
    </aside>
  );
}
