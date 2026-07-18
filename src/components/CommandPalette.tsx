import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { I, type IconName } from "../icons";
import { useAppStore } from "../state";
import { useShallow } from "zustand/react/shallow";
import { shortcut } from "../lib/platform";
import { engineBinaryName } from "../lib/chatUi";
import { activeEngine } from "../state/slices/serverSlice";

/** Navigation entry the palette turns into a "Go to …" command. Mirrors the
 *  sidebar NAV shape so both stay in sync from one source in App. */
export type CommandPaletteNavItem = {
  id: string;
  label: string;
  icon: IconName;
  /** Digit key ("1"…"0") the tab is bound to; rendered via shortcut(). */
  key: string;
};

type CommandGroup = "Navigation" | "Actions" | "Chats";

type Command = {
  key: string;
  group: CommandGroup;
  label: string;
  icon: IconName;
  /** Right-aligned dim label, e.g. a keyboard shortcut. */
  hint?: string;
  /** Performs the action. Each command closes the palette itself so callers
   *  don't have to remember to. */
  run: () => void;
};

/** Ctrl/⌘+K command palette: fuzzy-substring search over tab navigation,
 *  chats, and a few app actions. Mounted only while open (App conditionally
 *  renders it), so its transient state resets on every open for free. */
export function CommandPalette({
  onClose,
  nav,
  onNavigate,
  onToggleLogs,
}: Readonly<{
  onClose: () => void;
  nav: CommandPaletteNavItem[];
  onNavigate: (id: string) => void;
  onToggleLogs: () => void;
}>) {
  const { chats, newChat, selectChat, server, stopServer, settings, loadedEngine } = useAppStore(
    useShallow((s) => ({
      chats: s.chats,
      newChat: s.newChat,
      selectChat: s.selectChat,
      server: s.server,
      stopServer: s.stopServer,
      // Only fed into the commands useMemo's deps below, so it recomputes
      // the "Stop …" label when activeEngine() would resolve differently.
      settings: s.settings,
      loadedEngine: s.loadedEngine,
    })),
  );

  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const q = query.trim().toLowerCase();
  // Simple boolean so it's a valid useMemo dep (eslint's exhaustive-deps
  // rejects inline expressions like `!!server.info`) — see the deps comment
  // below for why activeEngine()'s inputs need to be tracked here.
  const serverHasInfo = !!server.info;

  const commands = useMemo<Command[]>(() => {
    const navCmds: Command[] = nav.map((n) => ({
      key: "nav:" + n.id,
      group: "Navigation",
      label: "Go to " + n.label,
      icon: n.icon,
      hint: shortcut(n.key),
      run: () => {
        onNavigate(n.id);
        onClose();
      },
    }));

    const actionCmds: Command[] = [
      {
        key: "act:new-chat",
        group: "Actions",
        label: "New chat",
        icon: "Plus",
        run: () => {
          newChat();
          onNavigate("chat");
          onClose();
        },
      },
    ];
    if (server.running) {
      // activeEngine names whichever server is actually running (not just
      // the Configure toggle) — see serverSlice.ts.
      actionCmds.push({
        key: "act:stop-server",
        group: "Actions",
        label: `Stop ${engineBinaryName(activeEngine(useAppStore.getState))}`,
        icon: "Stop",
        run: () => {
          stopServer().catch(() => {});
          onClose();
        },
      });
    }
    actionCmds.push({
      key: "act:toggle-logs",
      group: "Actions",
      label: "Toggle logs panel",
      icon: "Terminal",
      hint: shortcut("`"),
      run: () => {
        onToggleLogs();
        onClose();
      },
    });

    // Most-recently-updated first. Unfiltered, cap to 10; searching reaches
    // across every chat (the filter below trims the result set).
    const sortedChats = chats.slice().sort((a, b) => b.updated_at - a.updated_at);
    const chatSource = q ? sortedChats : sortedChats.slice(0, 10);
    const chatCmds: Command[] = chatSource.map((c) => ({
      key: "chat:" + c.id,
      group: "Chats",
      label: c.title,
      icon: "Chat",
      run: () => {
        selectChat(c.id);
        onNavigate("chat");
        onClose();
      },
    }));

    return [...navCmds, ...actionCmds, ...chatCmds];
    // settings.engine_kind/loadedEngine aren't referenced by name in the body
    // above (activeEngine() reads the store fresh instead) but DO change
    // which engine the "Stop …" label resolves to — kept in the deps so ESLint's
    // static analysis doesn't miss a real recompute trigger. Same reasoning for
    // server.ready/!!server.info: activeEngine() only trusts loadedEngine once
    // the server is running AND ready AND has info (see serverSlice.ts) — without
    // these, the "Stop …" label could resolve stale between a running-but-not-
    // ready server and the moment it reports ready.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    nav,
    chats,
    server.running,
    server.ready,
    serverHasInfo,
    settings.engine_kind,
    loadedEngine,
    q,
    newChat,
    selectChat,
    stopServer,
    onNavigate,
    onToggleLogs,
    onClose,
  ]);

  const visible = useMemo(
    () => (q ? commands.filter((c) => c.label.toLowerCase().includes(q)) : commands),
    [commands, q],
  );

  // Clamp selection: filtering can shrink the list below the current index.
  const active = visible.length ? Math.min(sel, visible.length - 1) : -1;

  // Keep the highlighted row in view as the keyboard moves it.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({
      block: "nearest",
    });
  }, [active]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => (visible.length ? (s + 1) % visible.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => (visible.length ? (s - 1 + visible.length) % visible.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active >= 0) visible[active].run();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="cmdk-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="cmdk-panel" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="cmdk-input-row">
          <I.Search />
          <input
            ref={inputRef}
            className="cmdk-input"
            autoFocus
            placeholder="Search commands, chats, and actions…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSel(0);
            }}
            onKeyDown={onKeyDown}
          />
          <span className="kbd">Esc</span>
        </div>
        <div className="cmdk-list" ref={listRef}>
          {visible.length === 0 ? (
            <div className="cmdk-empty">No results</div>
          ) : (
            visible.map((cmd, i) => {
              const showHeader = i === 0 || visible[i - 1].group !== cmd.group;
              const isActive = i === active;
              const Ico = I[cmd.icon];
              return (
                <Fragment key={cmd.key}>
                  {showHeader && <div className="cmdk-section">{cmd.group}</div>}
                  <button
                    type="button"
                    data-active={isActive || undefined}
                    className={"cmdk-item" + (isActive ? " active" : "")}
                    // Keep focus on the input so typing continues to work.
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setSel(i)}
                    onClick={() => cmd.run()}
                  >
                    <span className="cmdk-ico">
                      <Ico size={14} />
                    </span>
                    <span className="cmdk-label">{cmd.label}</span>
                    {cmd.hint && <span className="cmdk-hint mono">{cmd.hint}</span>}
                  </button>
                </Fragment>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
