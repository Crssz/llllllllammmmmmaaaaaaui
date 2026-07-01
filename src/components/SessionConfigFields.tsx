import { useState } from "react";
import { I } from "../icons";
import {
  api,
  type ChatSessionConfig,
  type McpServerConfig,
  type McpStatus,
  type McpTool,
  type ToolPermission,
} from "../lib/api";
import { WORKSPACE_SERVER_ID, WORKSPACE_SERVER_NAME, WORKSPACE_TOOLS } from "../lib/workspaceTools";

/** Shared collapsible section wrapper used across session/workspace config
 *  editors. */
export function Section({
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

export function ToolPermSelect({
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

/**
 * The reusable body of a `ChatSessionConfig` editor: project folder, system
 * prompt, chat template, MCP server selection, and tool permissions. Bound
 * to whatever config object + updater the caller passes in — used both for a
 * single chat's session config (`ChatSidebar`) and a workspace's default
 * config (`WorkspaceConfigOverlay`).
 */
export function SessionConfigFields({
  config: cfg,
  onChange: update,
  mcpServers,
  mcpStatuses,
  mcpTools,
}: Readonly<{
  config: ChatSessionConfig;
  onChange: (patch: Partial<ChatSessionConfig>) => void;
  mcpServers: McpServerConfig[];
  mcpStatuses: Record<string, McpStatus>;
  mcpTools: Record<string, McpTool[]>;
}>) {
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

  return (
    <>
      <Section title="Project folder" icon="Folder">
        {cfg.workspace_root ? (
          <>
            <div
              className="mono"
              title={cfg.workspace_root}
              style={{
                fontSize: 11.5,
                color: "var(--text-2)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                direction: "rtl",
                textAlign: "left",
              }}
            >
              {cfg.workspace_root}
            </div>
            <div className="chat-side-row" style={{ marginTop: 6 }}>
              <button
                className="btn"
                onClick={async () => {
                  const p = await api.pickFolder("Open a project folder");
                  if (p) update({ workspace_root: p });
                }}
              >
                <I.Folder size={11} /> Change
              </button>
              <button
                className="btn ghost"
                style={{ color: "var(--red)" }}
                onClick={() => update({ workspace_root: null })}
                title="Close the project — the model loses its file tools"
              >
                <I.X size={11} /> Close
              </button>
            </div>
            <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 6 }}>
              The model can list, search and read files here without asking; edits and writes follow
              the tool permissions below.
            </div>
          </>
        ) : (
          <>
            <button
              className="btn primary"
              onClick={async () => {
                const p = await api.pickFolder("Open a project folder");
                if (p) update({ workspace_root: p });
              }}
            >
              <I.Folder size={11} /> Open project folder…
            </button>
            <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 6 }}>
              Give the model file tools (read, search, edit, write) rooted at a folder of your
              choice — like a coding assistant for that project.
            </div>
          </>
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
        {cfg.workspace_root &&
          WORKSPACE_TOOLS.map((t) => {
            const key = `${WORKSPACE_SERVER_ID}:${t.name}`;
            const policy = cfg.tool_permissions.per_tool[key];
            // Read-only project-folder tools are auto-allowed unless
            // overridden or the session default is deny — show that
            // effective value.
            const effective =
              t.readOnly && cfg.tool_permissions.default !== "deny"
                ? "allow"
                : cfg.tool_permissions.default;
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
                  <div style={{ fontSize: 10.5, color: "var(--subtle)" }}>
                    {WORKSPACE_SERVER_NAME}
                  </div>
                </div>
                <ToolPermSelect
                  value={policy ?? effective}
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
          })}
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
    </>
  );
}
