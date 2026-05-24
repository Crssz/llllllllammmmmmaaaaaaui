import { useEffect, useState } from "react";
import { I } from "./icons";
import { AGENCY_LABELS, type Agency } from "./data";
import { ChatScreen } from "./screens/Chat";
import { ConfigureScreen } from "./screens/Configure";
import { HardwareScreen } from "./screens/Hardware";
import { ProfilesScreen } from "./screens/Profiles";
import { ModelsScreen } from "./screens/Models";
import { McpScreen } from "./screens/Mcp";
import { useAppState } from "./state";
import { LogsPanel } from "./components/LogsPanel";
import { ModelLibraryOverlay } from "./components/ModelLibraryOverlay";
import { Toasts } from "./components/Toasts";
import { log } from "./lib/logger";

type Tab = "chat" | "models" | "configure" | "hardware" | "profiles" | "mcp";

function ModePills({ value, onChange }: { value: Agency; onChange: (a: Agency) => void }) {
  return (
    <div className="mode-pills" role="tablist" aria-label="Pilot mode">
      {(Object.entries(AGENCY_LABELS) as [Agency, (typeof AGENCY_LABELS)[Agency]][]).map(
        ([k, m]) => {
          const IconCmp = I[m.icon];
          return (
            <button
              key={k}
              className={"mode-pill" + (value === k ? " active" : "")}
              onClick={() => onChange(k)}
              title={m.desc}
            >
              <IconCmp size={12} />
              {m.name}
            </button>
          );
        },
      )}
    </div>
  );
}

function basename(p: string): string {
  if (!p) return "";
  const sep = p.includes("\\") ? "\\" : "/";
  return p.split(sep).pop() || p;
}

function TopBar({
  agency,
  onAgency,
  onSwitchToBinary,
  onSwitchToModels,
  onToggleLogs,
  logsOpen,
  pickerOpen,
  setPickerOpen,
}: {
  agency: Agency;
  onAgency: (a: Agency) => void;
  onSwitchToBinary: () => void;
  onSwitchToModels: () => void;
  onToggleLogs: () => void;
  logsOpen: boolean;
  pickerOpen: boolean;
  setPickerOpen: (v: boolean) => void;
}) {
  const { server, flags, stopServer, modelInfo } = useAppState();
  const modelPath = (flags.model as string) || "";
  const modelName = modelPath ? basename(modelPath) : "no model";
  // Three states: stopped (muted), running-but-loading (yellow), ready (green).
  const dotColor = !server.running
    ? "var(--muted)"
    : server.ready
      ? "var(--green)"
      : "var(--yellow)";
  void stopServer;
  void onSwitchToModels;

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
        {modelInfo?.mtp_support && flags.spec_type === "draft-mtp" && (
          <span className="mono" style={{ color: "var(--accent)", fontSize: 11 }}>
            + MTP
          </span>
        )}
        <span className="meta mono">
          {server.running ? (server.ready ? `:${server.info?.port}` : "loading…") : "stopped"}
        </span>
        <I.Chevron
          size={12}
          style={{
            transform: pickerOpen ? "rotate(180deg)" : undefined,
            transition: "transform 0.15s",
          }}
        />
      </button>

      <ModePills value={agency} onChange={onAgency} />

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

function Sidebar({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  const { server, settings, chats, currentChatId, selectChat, newChat } = useAppState();
  const NAV: { id: Tab; label: string; icon: keyof typeof I; meta: string }[] = [
    { id: "chat", label: "Chat", icon: "Chat", meta: "⌘1" },
    { id: "models", label: "Models", icon: "Folder", meta: "⌘2" },
    { id: "configure", label: "Configure", icon: "Sliders", meta: "⌘3" },
    { id: "hardware", label: "Hardware", icon: "Hardware", meta: "⌘4" },
    { id: "profiles", label: "Profiles", icon: "Bookmark", meta: "⌘5" },
    { id: "mcp", label: "MCP", icon: "Globe", meta: "⌘6" },
  ];

  const pinned = chats.filter((c) => c.pinned).sort((a, b) => b.updated_at - a.updated_at);
  const recents = chats
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
      <div className="nav-label">Workspace</div>
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
  const [s, ss] = useState(() => {
    const d = new Date();
    return d.toTimeString().slice(0, 5);
  });
  useEffect(() => {
    const id = setInterval(() => {
      const d = new Date();
      ss(d.toTimeString().slice(0, 5));
    }, 30_000);
    return () => clearInterval(id);
  }, []);
  return s;
}

function StatusBar({ agency }: { agency: Agency }) {
  const t = useTime();
  const { server, build, flags } = useAppState();
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
        {agency === "auto" ? "100" : String(flags.ngl)}
      </span>
      <span className="right">
        <span style={{ color: "var(--accent)" }}>{AGENCY_LABELS[agency].name.toLowerCase()}</span>
        <span>{t}</span>
      </span>
    </div>
  );
}

export function App() {
  const [tab, setTab] = useState<Tab>("configure");
  const { agency, setAgency } = useAppState();
  const [configureTabRequest, setConfigureTabRequest] = useState<string | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    const tabs: Tab[] = ["chat", "models", "configure", "hardware", "profiles", "mcp"];
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && /^[1-6]$/.test(e.key)) {
        e.preventDefault();
        setTab(tabs[Number(e.key) - 1]);
      } else if ((e.metaKey || e.ctrlKey) && e.key === "`") {
        e.preventDefault();
        setLogsOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    log.debug("nav", `tab → ${tab}`);
  }, [tab]);

  return (
    <div className="app">
      <TopBar
        agency={agency}
        onAgency={setAgency}
        onSwitchToBinary={() => {
          setTab("configure");
          setConfigureTabRequest("binary");
        }}
        onSwitchToModels={() => setTab("models")}
        logsOpen={logsOpen}
        onToggleLogs={() => setLogsOpen((o) => !o)}
        pickerOpen={pickerOpen}
        setPickerOpen={setPickerOpen}
      />
      <div className="layout">
        <Sidebar tab={tab} onTab={setTab} />
        <main className="main" data-screen-label={tab}>
          {tab === "chat" && <ChatScreen agency={agency} />}
          {tab === "models" && <ModelsScreen />}
          {tab === "configure" && (
            <ConfigureScreen
              agency={agency}
              initialTab={configureTabRequest}
              onTabConsumed={() => setConfigureTabRequest(null)}
            />
          )}
          {tab === "hardware" && <HardwareScreen />}
          {tab === "profiles" && <ProfilesScreen />}
          {tab === "mcp" && <McpScreen />}
        </main>
      </div>
      <StatusBar agency={agency} />
      <LogsPanel open={logsOpen} onClose={() => setLogsOpen(false)} />
      <ModelLibraryOverlay
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onOpenModelsTab={() => setTab("models")}
      />
      <Toasts />
    </div>
  );
}
