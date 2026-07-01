import { useEffect, useRef, useState } from "react";
import { I } from "../icons";
import { useAppStore } from "../state";
import { useShallow } from "zustand/react/shallow";
import { SessionConfigFields } from "./SessionConfigFields";

/**
 * Full-width editor for a workspace's default config (project folder, system
 * prompt, MCP servers, tool permissions), plus rename/delete. Follows the
 * same backdrop + click-outside/Escape convention as `ModelLibraryOverlay`.
 * Renders nothing when `workspaceId` doesn't resolve to a workspace.
 */
export function WorkspaceConfigOverlay({
  workspaceId,
  onClose,
}: Readonly<{ workspaceId: string | null; onClose: () => void }>) {
  const {
    workspaces,
    mcpServers,
    mcpStatuses,
    mcpTools,
    renameWorkspace,
    deleteWorkspace,
    updateWorkspaceConfig,
  } = useAppStore(
    useShallow((s) => ({
      workspaces: s.settings.workspaces,
      mcpServers: s.settings.mcp_servers,
      mcpStatuses: s.mcpStatuses,
      mcpTools: s.mcpTools,
      renameWorkspace: s.renameWorkspace,
      deleteWorkspace: s.deleteWorkspace,
      updateWorkspaceConfig: s.updateWorkspaceConfig,
    })),
  );

  const workspace = workspaceId ? (workspaces.find((w) => w.id === workspaceId) ?? null) : null;
  const open = workspace != null;

  const panelRef = useRef<HTMLDivElement | null>(null);
  const [name, setName] = useState("");

  useEffect(() => {
    if (workspace) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setName(workspace.name);
    }
    // Only reset the draft name when switching to a different workspace, not
    // on every config edit (which would clobber in-progress typing).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.id]);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (panelRef.current && e.target instanceof Node && !panelRef.current.contains(e.target)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    globalThis.addEventListener("mousedown", onDocMouseDown);
    globalThis.addEventListener("keydown", onKey);
    return () => {
      globalThis.removeEventListener("mousedown", onDocMouseDown);
      globalThis.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open || !workspace) return null;

  const commitRename = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== workspace.name) renameWorkspace(workspace.id, trimmed);
  };

  const onDelete = () => {
    if (
      !confirm(
        `Delete workspace "${workspace.name}"? Its chats move to "All chats" — they are not deleted.`,
      )
    ) {
      return;
    }
    deleteWorkspace(workspace.id);
    onClose();
  };

  return (
    <>
      <div
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.35)",
          backdropFilter: "blur(2px)",
          zIndex: 70,
        }}
      />
      <div
        ref={panelRef}
        style={{
          position: "fixed",
          top: 50,
          left: 16,
          right: 16,
          bottom: 40,
          background: "var(--bg-elev)",
          border: "1px solid var(--border-strong)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-pop)",
          zIndex: 71,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "14px 18px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            gap: 10,
            alignItems: "center",
            background: "linear-gradient(180deg, var(--surface), var(--bg-elev))",
          }}
        >
          <I.Layers size={14} style={{ color: "var(--accent)" }} />
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
            }}
            style={{ fontSize: 14, fontWeight: 600, maxWidth: 280 }}
          />
          <span style={{ flex: 1 }} />
          <button className="btn ghost" style={{ color: "var(--red)" }} onClick={onDelete}>
            <I.Trash size={11} /> Delete workspace
          </button>
          <button
            className="iconbtn"
            title="Close"
            onClick={onClose}
            style={{ width: 22, height: 22 }}
          >
            <I.X size={13} />
          </button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "4px 4px" }}>
          <SessionConfigFields
            config={workspace.config}
            onChange={(patch) => updateWorkspaceConfig(workspace.id, patch)}
            mcpServers={mcpServers}
            mcpStatuses={mcpStatuses}
            mcpTools={mcpTools}
          />
        </div>
        <div
          style={{
            padding: "8px 18px",
            borderTop: "1px solid var(--border)",
            fontSize: 11.5,
            color: "var(--muted)",
          }}
        >
          New chats created in this workspace start with this config — existing chats aren&apos;t
          updated retroactively.
        </div>
      </div>
    </>
  );
}
