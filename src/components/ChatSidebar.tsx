import { useMemo, useState } from "react";
import { I } from "../icons";
import { useAppStore, useCurrentChat } from "../state";
import { useShallow } from "zustand/react/shallow";
import { defaultSessionConfig, type ChatSessionConfig } from "../lib/api";
import { Section, SessionConfigFields } from "./SessionConfigFields";
import { useConfirm } from "./ConfirmDialog";
import { activeEngine } from "../state/slices/serverSlice";

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
      // Subscribed only so this re-renders when activeEngine() (below) would
      // resolve differently — it re-reads the full store fresh, so these
      // aren't otherwise consumed directly.
      server: s.server,
      loadedEngine: s.loadedEngine,
    })),
  );
  // hipfire strips tool calls from every request (fact 3: the daemon force-
  // stops generation at `<tool_call>`, no structured call ever emitted) — the
  // session's MCP/workspace-tool controls stay visible but render disabled.
  const toolsDisabledForEngine = activeEngine(useAppStore.getState) === "hipfire";

  const [newPresetName, setNewPresetName] = useState("");
  const [savingPreset, setSavingPreset] = useState(false);
  const { confirmElement, confirm } = useConfirm();

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

  const onApplyPreset = async (id: string) => {
    if (!id) return;
    if (
      cfg.system_prompt ||
      cfg.chat_template ||
      cfg.mcp_server_ids.length > 0 ||
      Object.keys(cfg.tool_permissions.per_tool).length > 0
    ) {
      const ok = await confirm({
        title: "Replace this session's config?",
        body: "The selected preset will overwrite the current session settings.",
        confirmLabel: "Replace",
      });
      if (!ok) return;
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
              const preset = settings.chat_presets.find((p) => p.id === cfg.preset_id);
              const ok = await confirm({
                title: `Delete preset "${preset?.name ?? "preset"}"?`,
                confirmLabel: "Delete",
                danger: true,
              });
              if (!ok) return;
              await deletePreset(cfg.preset_id);
              update({ preset_id: null });
            }}
          >
            <I.X size={11} /> Delete linked preset
          </button>
        )}
      </Section>

      <SessionConfigFields
        config={cfg}
        onChange={update}
        mcpServers={mcpServers}
        mcpStatuses={mcpStatuses}
        mcpTools={mcpTools}
        toolsDisabledForEngine={toolsDisabledForEngine}
      />
      {confirmElement}
    </aside>
  );
}
