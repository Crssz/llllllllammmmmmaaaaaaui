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
import { LogsPanel } from "./components/LogsPanel";
import { ModelLibraryOverlay } from "./components/ModelLibraryOverlay";
import { WorkspaceConfigOverlay } from "./components/WorkspaceConfigOverlay";
import { Toasts } from "./components/Toasts";
import { log } from "./lib/logger";

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

function basename(p: string): string {
  if (!p) return "";
  const sep = p.includes("\\") ? "\\" : "/";
  return p.split(sep).pop() || p;
}

type ServerLike = { running: boolean; ready: boolean; info?: { port?: number } | null };

// Compact "stopped / loading… / :PORT" label for the model picker.
function serverStatusLabel(server: ServerLike): string {
  if (!server.running) return "stopped";
  return server.ready ? `:${server.info?.port}` : "loading…";
}

function TopBar({
  onSwitchToBinary,
  onToggleLogs,
  logsOpen,
  pickerOpen,
  setPickerOpen,
}: Readonly<{
  onSwitchToBinary: () => void;
  onToggleLogs: () => void;
  logsOpen: boolean;
  pickerOpen: boolean;
  setPickerOpen: (v: boolean) => void;
}>) {
  const { server, flags, stopServer } = useAppStore(
    useShallow((s) => ({
      server: s.server,
      flags: s.flags,
      stopServer: s.stopServer,
    })),
  );
  const modelPath = (flags.model as string) || "";
  const modelName = modelPath ? basename(modelPath) : "no model";
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
        title={modelPath || "No model selected — click to open the library"}
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
        {flags.spec_type === "draft-mtp" && (
          <span className="mono" style={{ color: "var(--accent)", fontSize: 11 }}>
            + MTP
          </span>
        )}
        {flags.spec_type === "draft-dflash" && (
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
        <button className="searchbtn">
          <I.Search />
          <span>Jump to…</span>
          <span className="kbd">⌘K</span>
        </button>
        <button
          className="iconbtn"
          title={logsOpen ? "Hide logs" : "Show logs"}
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
          title={server.running ? "Stop llama-server" : "Server stopped"}
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
}: Readonly<{ tab: Tab; onTab: (t: Tab) => void; onEditWorkspace: (id: string) => void }>) {
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
    })),
  );

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
  const NAV: { id: Tab; label: string; icon: keyof typeof I; meta: string }[] = [
    { id: "chat", label: "Chat", icon: "Chat", meta: "⌘1" },
    { id: "models", label: "Models", icon: "Folder", meta: "⌘2" },
    { id: "catalog", label: "Catalog", icon: "Cloud", meta: "⌘3" },
    { id: "configure", label: "Configure", icon: "Sliders", meta: "⌘4" },
    { id: "hardware", label: "Hardware", icon: "Hardware", meta: "⌘5" },
    { id: "profiles", label: "Profiles", icon: "Bookmark", meta: "⌘6" },
    { id: "mcp", label: "MCP", icon: "Globe", meta: "⌘7" },
    { id: "audio", label: "Audio", icon: "Mic", meta: "⌘8" },
    { id: "bench", label: "Bench", icon: "Bolt", meta: "⌘9" },
    { id: "engine", label: "Engine", icon: "Download", meta: "⌘0" },
  ];

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

  const tokensFor = (msgs: { content: string }[]) =>
    msgs.reduce((n, m) => n + Math.ceil(m.content.length / 4), 0);

  // Hoisted out of the JSX conditional so the hook order is stable across
  // renders regardless of `server.running`.
  const uptime = useUptime(server.info?.started_at);

  return (
    <aside className="sidebar">
      <div className="nav-label">Navigate</div>
      {NAV.map((n) => {
        const IconCmp = I[n.icon];
        return (
          <button
            key={n.id}
            className={"nav-item" + (tab === n.id ? " active" : "")}
            onClick={() => onTab(n.id)}
          >
            <IconCmp className="nav-icon" />
            <span>{n.label}</span>
            <span className="nav-meta">{n.meta}</span>
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
          <div key={w.id} style={{ display: "flex", alignItems: "center", gap: 2 }}>
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
          {server.running ? `llama-server · pid ${server.info?.pid}` : "llama-server · stopped"}
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
            {settings.build_dir
              ? "Press Start on Configure to launch"
              : "Pick a build dir on Configure → Binary"}
          </div>
        )}
      </div>
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
  const { server, build, flags } = useAppStore(
    useShallow((s) => ({ server: s.server, build: s.build, flags: s.flags })),
  );
  const binary = build?.resolved_path
    ? `${build.resolved_path}${build.resolved_path.includes("\\") ? "\\" : "/"}llama-server`
    : "llama-server";
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
            ? `llama-server :${server.info?.port}`
            : `llama-server :${server.info?.port} (loading)`
          : "llama-server (stopped)"}
      </span>
      <span className="sep" />
      <span className="cmd-snippet">
        $ {binary} --model {basename((flags.model as string) || "")} -c {flags.ctx} -ngl{" "}
        {String(flags.ngl)}
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
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(null);

  useEffect(() => {
    const tabs: Tab[] = [
      "chat",
      "models",
      "catalog",
      "configure",
      "hardware",
      "profiles",
      "mcp",
      "audio",
      "bench",
      "engine",
    ];
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && /^[0-9]$/.test(e.key)) {
        e.preventDefault();
        // Keys 1-9 select the first nine tabs; 0 selects the tenth (Engine).
        const idx = e.key === "0" ? 9 : Number(e.key) - 1;
        if (idx < tabs.length) setTab(tabs[idx]);
      } else if ((e.metaKey || e.ctrlKey) && e.key === "`") {
        e.preventDefault();
        setLogsOpen((o) => !o);
      }
    };
    globalThis.addEventListener("keydown", onKey);
    return () => globalThis.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    log.debug("nav", `tab → ${tab}`);
  }, [tab]);

  return (
    <div className="app">
      <TopBar
        onSwitchToBinary={() => {
          setTab("configure");
          setConfigureTabRequest("binary");
        }}
        logsOpen={logsOpen}
        onToggleLogs={() => setLogsOpen((o) => !o)}
        pickerOpen={pickerOpen}
        setPickerOpen={setPickerOpen}
      />
      <div className="layout">
        <Sidebar tab={tab} onTab={setTab} onEditWorkspace={setEditingWorkspaceId} />
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
      <Toasts />
    </div>
  );
}
