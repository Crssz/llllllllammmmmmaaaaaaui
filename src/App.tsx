import { useEffect, useState } from "react";
import { I } from "./icons";
import { ChatScreen } from "./screens/Chat";
import { ConfigureScreen } from "./screens/Configure";
import { HardwareScreen } from "./screens/Hardware";
import { ProfilesScreen } from "./screens/Profiles";
import { ModelsScreen } from "./screens/Models";
import { CatalogScreen } from "./screens/Catalog";
import { McpScreen } from "./screens/Mcp";
import { TranscribeScreen } from "./screens/Transcribe";
import { BenchScreen } from "./screens/Bench";
import { EngineManagerScreen } from "./screens/EngineManager";
import { useAppStore } from "./state";
import { useShallow } from "zustand/react/shallow";
import { activeEngine, activeModelLabel } from "./state/slices/serverSlice";
import { LogsPanel } from "./components/LogsPanel";
import { ModelLibraryOverlay } from "./components/ModelLibraryOverlay";
import { WorkspaceConfigOverlay } from "./components/WorkspaceConfigOverlay";
import { Toasts } from "./components/Toasts";
import { ContextMenuProvider, useContextMenu, type MenuItem } from "./components/ContextMenu";
import { useTextPrompt } from "./components/TextPromptDialog";
import { useConfirm } from "./components/ConfirmDialog";
import { CommandPalette, type CommandPaletteNavItem } from "./components/CommandPalette";
import { shortcut } from "./lib/platform";
import type { ChatSession, Workspace } from "./lib/api";
import { log } from "./lib/logger";
import { buildHipfireArgs } from "./lib/buildHipfireArgs";
import { basename, engineBinaryName } from "./lib/chatUi";
import type { FlagValues } from "./state/types";

type Tab =
  | "chat"
  | "models"
  | "catalog"
  | "configure"
  | "hardware"
  | "profiles"
  | "mcp"
  | "audio"
  | "bench"
  | "engine";

// Single source of truth for the primary tabs: drives the sidebar nav, the
// Ctrl/⌘+digit shortcuts, and the command palette's "Go to …" entries. `key`
// is the digit the tab binds to ("1"…"9", "0" for the tenth); labels render
// via shortcut() so they follow the host OS (Ctrl on Windows, ⌘ on Mac).
const NAV: CommandPaletteNavItem[] = [
  { id: "chat", label: "Chat", icon: "Chat", key: "1" },
  { id: "models", label: "Models", icon: "Folder", key: "2" },
  { id: "catalog", label: "Catalog", icon: "Cloud", key: "3" },
  { id: "configure", label: "Configure", icon: "Sliders", key: "4" },
  { id: "hardware", label: "Hardware", icon: "Hardware", key: "5" },
  { id: "profiles", label: "Profiles", icon: "Bookmark", key: "6" },
  { id: "mcp", label: "MCP", icon: "Globe", key: "7" },
  { id: "audio", label: "Audio", icon: "Mic", key: "8" },
  { id: "bench", label: "Bench", icon: "Bolt", key: "9" },
  { id: "engine", label: "Engine", icon: "Download", key: "0" },
];

type ServerLike = { running: boolean; ready: boolean; info?: { port?: number } | null };

// Compact "stopped / loading… / :PORT" label for the model picker.
function serverStatusLabel(server: ServerLike): string {
  if (!server.running) return "stopped";
  return server.ready ? `:${server.info?.port}` : "loading…";
}

function TopBar({
  onSwitchToBinary,
  onToggleLogs,
  onOpenPalette,
  logsOpen,
  pickerOpen,
  setPickerOpen,
}: Readonly<{
  onSwitchToBinary: () => void;
  onToggleLogs: () => void;
  onOpenPalette: () => void;
  logsOpen: boolean;
  pickerOpen: boolean;
  setPickerOpen: (v: boolean) => void;
}>) {
  const { server, flags, stopServer } = useAppStore(
    useShallow((s) => ({
      server: s.server,
      flags: s.flags,
      stopServer: s.stopServer,
      // Subscribed only so this re-renders when activeEngine()/
      // activeModelLabel() (below) would resolve differently — read fresh
      // via useAppStore.getState() further down, not consumed by name here.
      settings: s.settings,
      loadedEngine: s.loadedEngine,
    })),
  );
  // A RUNNING server wins over the Configure toggle (activeEngine falls back
  // to the toggle only while nothing's up) — this top bar always names/
  // identifies what's actually serving, not just what would launch next.
  const engine = activeEngine(useAppStore.getState);
  const modelLabel = activeModelLabel(useAppStore.getState);
  const engineName = engineBinaryName(engine);
  const modelName = modelLabel == null ? "no model" : engine === "hipfire" ? modelLabel : basename(modelLabel);
  // Three states: stopped (muted), running-but-loading (yellow), ready (green).
  let dotColor = "var(--muted)";
  if (server.running) dotColor = server.ready ? "var(--green)" : "var(--yellow)";

  return (
    <div className="topbar">
      <div className="brand">
        <div className="brand-mark">H</div>
        <div className="brand-name">
          llllllllammmmmmaaaaaaui <span className="dim mono">0.4.2</span>
        </div>
      </div>

      <button
        className="modelpicker"
        title={modelLabel || "No model selected — click to open the library"}
        onClick={() => setPickerOpen(!pickerOpen)}
      >
        <span
          className="dot"
          style={{
            background: dotColor,
            boxShadow: server.running ? `0 0 8px ${dotColor}` : "none",
          }}
        />
        <span className="name">{modelName}</span>
        {/* spec_type is a llama-server-only flag (draft-mtp/draft-dflash) that
            persists in settings across an engine switch — gate on the active
            engine so a leftover llama spec_type can't imply MTP/DFlash
            speculative decoding applies to a hipfire tag. */}
        {engine !== "hipfire" && flags.spec_type === "draft-mtp" && (
          <span className="mono" style={{ color: "var(--accent)", fontSize: 11 }}>
            + MTP
          </span>
        )}
        {engine !== "hipfire" && flags.spec_type === "draft-dflash" && (
          <span className="mono" style={{ color: "var(--accent)", fontSize: 11 }}>
            + DFlash
          </span>
        )}
        <span className="meta mono">{serverStatusLabel(server)}</span>
        <I.Chevron
          size={12}
          style={{
            transform: pickerOpen ? "rotate(180deg)" : undefined,
            transition: "transform 0.15s",
          }}
        />
      </button>

      <div className="top-actions">
        <button className="searchbtn" onClick={onOpenPalette}>
          <I.Search />
          <span>Jump to…</span>
          <span className="kbd">{shortcut("K")}</span>
        </button>
        <button
          className="iconbtn"
          title={logsOpen ? `Hide logs (${shortcut("`")})` : `Show logs (${shortcut("`")})`}
          onClick={onToggleLogs}
          style={{
            color: logsOpen ? "var(--accent)" : undefined,
            background: logsOpen ? "var(--surface)" : undefined,
          }}
        >
          <I.Terminal />
        </button>
        <button
          className="iconbtn"
          title={server.running ? `Stop ${engineName}` : "Server stopped"}
          disabled={!server.running}
          onClick={() => stopServer().catch(() => {})}
          style={{ opacity: server.running ? 1 : 0.4 }}
        >
          <I.Eject />
        </button>
        <button className="iconbtn" title="llama.cpp build settings" onClick={onSwitchToBinary}>
          <I.Settings />
        </button>
      </div>
    </div>
  );
}

function Sidebar({
  tab,
  onTab,
  onEditWorkspace,
  nav,
}: Readonly<{
  tab: Tab;
  onTab: (t: Tab) => void;
  onEditWorkspace: (id: string) => void;
  /** Filtered NAV — Audio dropped while hipfire is the active engine (see App). */
  nav: CommandPaletteNavItem[];
}>) {
  const {
    server,
    settings,
    chats,
    currentChatId,
    selectChat,
    newChat,
    currentWorkspaceId,
    selectWorkspace,
    createWorkspace,
    togglePinChat,
    renameChat,
    deleteChat,
    duplicateChat,
    setChatWorkspace,
    renameWorkspace,
    deleteWorkspace,
    chatStreamingId,
  } = useAppStore(
    useShallow((s) => ({
      server: s.server,
      settings: s.settings,
      chats: s.chats,
      currentChatId: s.currentChatId,
      selectChat: s.selectChat,
      newChat: s.newChat,
      currentWorkspaceId: s.currentWorkspaceId,
      selectWorkspace: s.selectWorkspace,
      createWorkspace: s.createWorkspace,
      togglePinChat: s.togglePinChat,
      renameChat: s.renameChat,
      deleteChat: s.deleteChat,
      duplicateChat: s.duplicateChat,
      setChatWorkspace: s.setChatWorkspace,
      renameWorkspace: s.renameWorkspace,
      deleteWorkspace: s.deleteWorkspace,
      chatStreamingId: s.chatStreamingId,
      // Subscribed only so this re-renders when activeEngine() (below) would
      // resolve differently.
      loadedEngine: s.loadedEngine,
    })),
  );

  const openMenu = useContextMenu();
  const { promptElement, openPrompt } = useTextPrompt();
  const { confirmElement, confirm } = useConfirm();

  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [newWsName, setNewWsName] = useState("");

  const commitCreateWorkspace = async () => {
    const name = newWsName.trim();
    if (!name) return;
    const id = await createWorkspace(name);
    selectWorkspace(id);
    setNewWsName("");
    setCreatingWorkspace(false);
  };

  const scopedChats =
    currentWorkspaceId === null
      ? chats
      : chats.filter((c) => c.workspace_id === currentWorkspaceId);
  const pinned = scopedChats.filter((c) => c.pinned).sort((a, b) => b.updated_at - a.updated_at);
  const recents = scopedChats
    .filter((c) => !c.pinned)
    .sort((a, b) => b.updated_at - a.updated_at)
    .slice(0, 8);

  const openChat = (id: string) => {
    selectChat(id);
    onTab("chat");
  };

  // Right-click menu for a chat row (pinned or recent).
  const chatMenuItems = (c: ChatSession): MenuItem[] => [
    { label: "Open", icon: "Chat", onClick: () => openChat(c.id) },
    { label: c.pinned ? "Unpin" : "Pin", icon: "Pin", onClick: () => togglePinChat(c.id) },
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
      label: "Duplicate",
      icon: "Copy",
      disabled: chatStreamingId === c.id,
      onClick: () => {
        duplicateChat(c.id);
        onTab("chat");
      },
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
        ...settings.workspaces.map(
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
    {
      label: "Delete chat…",
      icon: "Trash",
      danger: true,
      onClick: async () => {
        if (await confirm({ title: `Delete "${c.title}"?`, danger: true, confirmLabel: "Delete" }))
          deleteChat(c.id);
      },
    },
  ];

  const workspaceMenuItems = (w: Workspace): MenuItem[] => [
    { label: "Open workspace", icon: "Layers", onClick: () => selectWorkspace(w.id) },
    {
      label: "New chat here",
      icon: "Plus",
      onClick: () => {
        selectWorkspace(w.id);
        newChat();
        onTab("chat");
      },
    },
    "separator",
    {
      label: "Rename…",
      icon: "Pencil",
      onClick: () =>
        openPrompt({
          title: "Rename workspace",
          initial: w.name,
          onSubmit: (v) => renameWorkspace(w.id, v).catch(() => {}),
        }),
    },
    { label: "Edit config…", icon: "Settings", onClick: () => onEditWorkspace(w.id) },
    "separator",
    {
      label: "Delete workspace…",
      icon: "Trash",
      danger: true,
      onClick: async () => {
        if (
          await confirm({
            title: `Delete workspace "${w.name}"?`,
            body: `Its chats move to "All chats".`,
            danger: true,
            confirmLabel: "Delete",
          })
        )
          deleteWorkspace(w.id).catch(() => {});
      },
    },
  ];

  const tokensFor = (msgs: { content: string }[]) =>
    msgs.reduce((n, m) => n + Math.ceil(m.content.length / 4), 0);

  // Hoisted out of the JSX conditional so the hook order is stable across
  // renders regardless of `server.running`.
  const uptime = useUptime(server.info?.started_at);

  return (
    <aside className="sidebar">
      <div className="nav-label">Navigate</div>
      {nav.map((n) => {
        const IconCmp = I[n.icon];
        return (
          <button
            key={n.id}
            className={"nav-item" + (tab === n.id ? " active" : "")}
            onClick={() => onTab(n.id as Tab)}
          >
            <IconCmp className="nav-icon" />
            <span>{n.label}</span>
            <span className="nav-meta">{shortcut(n.key)}</span>
          </button>
        );
      })}

      <div className="nav-label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ flex: 1 }}>Workspaces</span>
        <button
          className="iconbtn"
          title="New workspace"
          onClick={() => setCreatingWorkspace((o) => !o)}
          style={{ width: 18, height: 18 }}
        >
          <I.Plus size={11} />
        </button>
      </div>
      <button
        className={"nav-item" + (currentWorkspaceId === null ? " active" : "")}
        onClick={() => selectWorkspace(null)}
      >
        <I.Layers className="nav-icon" />
        <span>All chats</span>
        <span className="nav-meta">{chats.length}</span>
      </button>
      {settings.workspaces.map((w) => {
        const count = chats.filter((c) => c.workspace_id === w.id).length;
        return (
          <div
            key={w.id}
            style={{ display: "flex", alignItems: "center", gap: 2 }}
            onContextMenu={(e) => openMenu(e, workspaceMenuItems(w))}
          >
            <button
              className={"nav-item" + (currentWorkspaceId === w.id ? " active" : "")}
              onClick={() => selectWorkspace(w.id)}
              title={w.name}
              style={{ flex: 1, minWidth: 0 }}
            >
              <I.Layers className="nav-icon" />
              <span
                style={{
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  flex: 1,
                }}
              >
                {w.name}
              </span>
              <span className="nav-meta">{count}</span>
            </button>
            <button
              className="iconbtn"
              title="Edit workspace"
              onClick={() => onEditWorkspace(w.id)}
              style={{ width: 20, height: 20, flexShrink: 0 }}
            >
              <I.Settings size={10} />
            </button>
          </div>
        );
      })}
      {creatingWorkspace && (
        <div className="chat-side-row" style={{ padding: "2px 10px 6px" }}>
          <input
            className="input"
            placeholder="Workspace name…"
            value={newWsName}
            autoFocus
            onChange={(e) => setNewWsName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitCreateWorkspace();
              if (e.key === "Escape") {
                setCreatingWorkspace(false);
                setNewWsName("");
              }
            }}
          />
          <button
            className="btn primary"
            disabled={!newWsName.trim()}
            onClick={commitCreateWorkspace}
            style={{ width: 28, height: 28, padding: 0, justifyContent: "center" }}
          >
            <I.Plus size={11} />
          </button>
        </div>
      )}

      <div className="nav-label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ flex: 1 }}>Pinned</span>
      </div>
      {pinned.length === 0 && (
        <div
          style={{
            padding: "2px 10px 4px",
            fontSize: 11,
            color: "var(--subtle)",
            fontStyle: "italic",
          }}
        >
          (none yet)
        </div>
      )}
      {pinned.map((c) => (
        <button
          key={c.id}
          className={"nav-item" + (currentChatId === c.id && tab === "chat" ? " active" : "")}
          onClick={() => openChat(c.id)}
          onContextMenu={(e) => openMenu(e, chatMenuItems(c))}
          title={c.title}
        >
          <I.Pin className="nav-icon" />
          <span
            style={{
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {c.title}
          </span>
        </button>
      ))}

      <div className="nav-label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ flex: 1 }}>Recent</span>
        <button
          className="iconbtn"
          title="New chat"
          onClick={() => {
            newChat();
            onTab("chat");
          }}
          style={{ width: 18, height: 18 }}
        >
          <I.Plus size={11} />
        </button>
      </div>
      {recents.length === 0 && (
        <div
          style={{
            padding: "2px 10px 4px",
            fontSize: 11,
            color: "var(--subtle)",
            fontStyle: "italic",
          }}
        >
          (no chats yet)
        </div>
      )}
      {recents.map((c) => {
        const toks = tokensFor(c.messages);
        return (
          <button
            key={c.id}
            className={"nav-item" + (currentChatId === c.id && tab === "chat" ? " active" : "")}
            onClick={() => openChat(c.id)}
            onContextMenu={(e) => openMenu(e, chatMenuItems(c))}
            title={c.title}
          >
            <I.Chat className="nav-icon" />
            <span
              style={{
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {c.title}
            </span>
            <span className="nav-meta">{toks > 999 ? (toks / 1000).toFixed(1) + "k" : toks}</span>
          </button>
        );
      })}

      <div className="runtime-card">
        <div className="rt-title">
          <span
            className="pulse"
            style={{
              background: !server.running
                ? "var(--muted)"
                : server.ready
                  ? "var(--green)"
                  : "var(--yellow)",
              boxShadow: server.running
                ? server.ready
                  ? "0 0 8px var(--green)"
                  : "0 0 8px var(--yellow)"
                : "none",
            }}
          />
          {/* activeEngine (not just the toggle) so a running server is named
              for what it actually is; falls back to the toggle while stopped. */}
          {server.running
            ? `${engineBinaryName(activeEngine(useAppStore.getState))} · pid ${server.info?.pid}`
            : `${engineBinaryName(activeEngine(useAppStore.getState))} · stopped`}
        </div>
        {server.running ? (
          <>
            <div className="rt-line">
              <span className="lbl">port</span>
              <span className="val">:{server.info?.port}</span>
            </div>
            <div className="rt-line">
              <span className="lbl">uptime</span>
              <span className="val">{uptime}</span>
            </div>
            {!server.ready && (
              <div className="rt-line" style={{ color: "var(--yellow)", fontSize: 11 }}>
                loading model…
              </div>
            )}
          </>
        ) : (
          <div className="rt-line" style={{ color: "var(--muted)", fontSize: 11 }}>
            {settings.engine_kind === "hipfire"
              ? // The hipfire binary is optional (auto-resolves from PATH /
                // ~/.hipfire/bin) — the tag is the real prerequisite now.
                String((settings.hipfire_flags as FlagValues)?.tag ?? "")
                ? "Press Start on Configure to launch"
                : "Set a model tag on Configure"
              : settings.build_dir
                ? "Press Start on Configure to launch"
                : "Pick a build dir on Configure → Binary"}
          </div>
        )}
      </div>
      {promptElement}
      {confirmElement}
    </aside>
  );
}

function useUptime(startedAt: number | undefined) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  if (!startedAt) return "—";
  const sec = Math.max(0, Math.floor((now - startedAt) / 1000));
  const h = Math.floor(sec / 3600)
    .toString()
    .padStart(2, "0");
  const m = Math.floor((sec % 3600) / 60)
    .toString()
    .padStart(2, "0");
  const s = Math.floor(sec % 60)
    .toString()
    .padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function useTime() {
  const [time, setTime] = useState(() => {
    const d = new Date();
    return d.toTimeString().slice(0, 5);
  });
  useEffect(() => {
    const id = setInterval(() => {
      const d = new Date();
      setTime(d.toTimeString().slice(0, 5));
    }, 30_000);
    return () => clearInterval(id);
  }, []);
  return time;
}

function StatusBar() {
  const t = useTime();
  const { server, build, flags, settings } = useAppStore(
    useShallow((s) => ({
      server: s.server,
      build: s.build,
      flags: s.flags,
      settings: s.settings,
      // Subscribed only so this re-renders when activeEngine() (below) would
      // resolve differently.
      loadedEngine: s.loadedEngine,
    })),
  );
  const isHipfire = settings.engine_kind === "hipfire";
  // Next-launch preview (binary path, cmdSnippet) stays keyed off the
  // Configure toggle — it's explicitly NOT the running process's actual args
  // (see comment below). The `live` status text below is different: it
  // describes the server that's actually up, so it's keyed off activeEngine.
  const engineName = engineBinaryName(settings.engine_kind);
  const binary = isHipfire
    ? settings.hipfire_path
    : build?.resolved_path
      ? `${build.resolved_path}${build.resolved_path.includes("\\") ? "\\" : "/"}${engineName}`
      : engineName;
  // Preview of what would launch with the current config — not the running
  // process's actual args (same semantics for both engines).
  const cmdSnippet = isHipfire
    ? `hipfire ${buildHipfireArgs(settings.hipfire_flags as FlagValues).join(" ")}`
    : `${binary} --model ${basename((flags.model as string) || "")} -c ${flags.ctx} -ngl ${String(flags.ngl)}`;
  const liveEngineName = engineBinaryName(activeEngine(useAppStore.getState));
  return (
    <div className="statusbar">
      <span
        className="live"
        style={{
          color: !server.running ? "var(--muted)" : server.ready ? "var(--green)" : "var(--yellow)",
        }}
      >
        {server.running
          ? server.ready
            ? `${liveEngineName} :${server.info?.port}`
            : `${liveEngineName} :${server.info?.port} (loading)`
          : `${liveEngineName} (stopped)`}
      </span>
      <span className="sep" />
      <span className="cmd-snippet">
        {/* The hipfire binary is optional — it auto-resolves from PATH /
            ~/.hipfire/bin at launch time — so an unset hipfire_path is no
            longer a blocking condition worth calling out here. */}
        {`$ ${cmdSnippet}`}
      </span>
      <span className="right">{t}</span>
    </div>
  );
}

export function App() {
  const [tab, setTab] = useState<Tab>("configure");
  const [configureTabRequest, setConfigureTabRequest] = useState<string | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(null);

  useAppStore(
    useShallow((s) => ({
      // Subscribed only so this re-renders when activeEngine() (below) would
      // resolve differently — read fresh via useAppStore.getState() further
      // down, not consumed by name here (same pattern TopBar/Sidebar/
      // StatusBar already use).
      server: s.server,
      loadedEngine: s.loadedEngine,
      engineKind: s.settings.engine_kind,
    })),
  );
  // Transcription (Audio) is llama-only by design (llama-server's audio
  // endpoint; hipfire has none — fact 7). Hide its nav entry + Ctrl+8
  // shortcut only when hipfire is the engine actually driving requests right
  // now — keyed off activeEngine (a running server wins over the raw
  // Configure toggle), so a running llama server keeps Audio available even
  // if the toggle was flipped without a restart. NAV's "key" values are
  // never renumbered — Audio's entry is just dropped from this filtered
  // list, so every other shortcut keeps binding to the same digit it shows.
  const audioAvailable = activeEngine(useAppStore.getState) !== "hipfire";
  const nav = audioAvailable ? NAV : NAV.filter((n) => n.id !== "audio");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (mod && /^[0-9]$/.test(e.key)) {
        e.preventDefault();
        // `nav` (not the static NAV) so a hidden Audio's "8" doesn't route
        // anywhere while hipfire is active.
        const item = nav.find((n) => n.key === e.key);
        if (item) setTab(item.id as Tab);
      } else if (mod && e.key === "`") {
        e.preventDefault();
        setLogsOpen((o) => !o);
      }
    };
    globalThis.addEventListener("keydown", onKey);
    return () => globalThis.removeEventListener("keydown", onKey);
  }, [nav]);

  useEffect(() => {
    log.debug("nav", `tab → ${tab}`);
  }, [tab]);

  // If Audio becomes unavailable (engine flips to hipfire) while the user is
  // actually on that tab, route them to Chat rather than stranding them on a
  // screen its own nav entry no longer points to.
  useEffect(() => {
    if (!audioAvailable && tab === "audio") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTab("chat");
    }
  }, [audioAvailable, tab]);

  return (
    <ContextMenuProvider>
      <div className="app">
        <TopBar
          onSwitchToBinary={() => {
            setTab("configure");
            setConfigureTabRequest("binary");
          }}
          logsOpen={logsOpen}
          onToggleLogs={() => setLogsOpen((o) => !o)}
          onOpenPalette={() => setPaletteOpen(true)}
          pickerOpen={pickerOpen}
          setPickerOpen={setPickerOpen}
        />
        <div className="layout">
          <Sidebar tab={tab} onTab={setTab} onEditWorkspace={setEditingWorkspaceId} nav={nav} />
          <main className="main" data-screen-label={tab}>
            {tab === "chat" && <ChatScreen />}
            {tab === "models" && <ModelsScreen />}
            {tab === "catalog" && <CatalogScreen />}
            {tab === "configure" && (
              <ConfigureScreen
                initialTab={configureTabRequest}
                onTabConsumed={() => setConfigureTabRequest(null)}
              />
            )}
            {tab === "hardware" && <HardwareScreen />}
            {tab === "profiles" && <ProfilesScreen />}
            {tab === "mcp" && <McpScreen />}
            {tab === "audio" && <TranscribeScreen />}
            {tab === "bench" && <BenchScreen />}
            {tab === "engine" && <EngineManagerScreen />}
          </main>
        </div>
        <StatusBar />
        <LogsPanel open={logsOpen} onClose={() => setLogsOpen(false)} />
        <ModelLibraryOverlay
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          onOpenModelsTab={() => setTab("models")}
        />
        <WorkspaceConfigOverlay
          workspaceId={editingWorkspaceId}
          onClose={() => setEditingWorkspaceId(null)}
        />
        {paletteOpen && (
          <CommandPalette
            onClose={() => setPaletteOpen(false)}
            nav={nav}
            onNavigate={(id) => setTab(id as Tab)}
            onToggleLogs={() => setLogsOpen((o) => !o)}
          />
        )}
        <Toasts />
      </div>
    </ContextMenuProvider>
  );
}
