import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { I, type IconName } from "../icons";

export type MenuItem =
  | "separator"
  | {
      label: string;
      icon?: IconName;
      /** Red text + red-soft hover — destructive actions. */
      danger?: boolean;
      disabled?: boolean;
      /** Dim mono text on the right edge (path, shortcut, size…). */
      hint?: string;
      onClick?: () => void;
      submenu?: MenuItem[];
    };

type MenuEvent = Pick<
  MouseEvent,
  "preventDefault" | "stopPropagation" | "clientX" | "clientY" | "target"
>;

/** Opens a context menu at the event's position. Call from onContextMenu;
 *  always prevents the native menu and stops the event so outer surfaces
 *  don't also open theirs. If the actual target is a text field, the passed
 *  `items` are replaced with a Cut/Copy/Paste/Select-all menu for that field
 *  — an ancestor's custom items (e.g. message actions) never win over
 *  editing the field the user actually clicked in. No-ops when the final
 *  item list is empty. */
export type OpenMenuFn = (e: MenuEvent, items: MenuItem[]) => void;

const MenuCtx = createContext<OpenMenuFn>(() => {});

export function useContextMenu(): OpenMenuFn {
  return useContext(MenuCtx);
}

type MenuState = { x: number; y: number; items: MenuItem[] };

type TextField = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

// Input types that behave like a text field (cut/copy/paste/select-all make
// sense). Excludes checkbox/radio/range/color/file/etc., where they don't.
const TEXT_INPUT_TYPES = new Set([
  "text",
  "search",
  "password",
  "email",
  "url",
  "tel",
  "number",
  "",
]);

// The nearest editable text field containing `target`, or null. Shared by
// open() (to override an ancestor's items) and the document-level fallback
// (for elements with no onContextMenu of their own) so both offer identical
// editing actions instead of ever falling through to the native menu.
function closestTextField(target: EventTarget | null): TextField | null {
  const el = target as HTMLElement | null;
  const hit = el?.closest?.('input, textarea, [contenteditable="true"]') as HTMLElement | null;
  if (!hit) return null;
  if (hit instanceof HTMLInputElement && !TEXT_INPUT_TYPES.has(hit.type)) return null;
  return hit;
}

function hasSelection(): boolean {
  const sel = globalThis.getSelection?.();
  return !!sel && !sel.isCollapsed && !!sel.toString().trim();
}

// Cut/Copy/Paste/Select-all for a text field — our replacement for the
// native menu there. Selection state is captured up front (menu build time)
// and restored before each action, since clicking a menu button can shift
// focus away from the field between opening the menu and acting on it.
function buildTextFieldMenu(field: TextField): MenuItem[] {
  const input =
    field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement ? field : null;
  const selStart = input?.selectionStart ?? null;
  const selEnd = input?.selectionEnd ?? null;
  const hasSel = input ? selStart !== selEnd : hasSelection();
  const readOnly = !!(input?.disabled || input?.readOnly);

  const refocus = () => {
    field.focus();
    if (input && selStart !== null && selEnd !== null) input.setSelectionRange(selStart, selEnd);
  };

  return [
    {
      label: "Cut",
      icon: "X",
      disabled: !hasSel || readOnly,
      onClick: () => {
        refocus();
        document.execCommand("cut");
      },
    },
    {
      label: "Copy",
      icon: "Copy",
      disabled: !hasSel,
      onClick: () => {
        refocus();
        document.execCommand("copy");
      },
    },
    {
      label: "Paste",
      icon: "Check",
      disabled: readOnly,
      onClick: () => {
        refocus();
        navigator.clipboard
          ?.readText()
          .then((text) => {
            if (!text) return;
            if (input) {
              const s = input.selectionStart ?? input.value.length;
              const e = input.selectionEnd ?? input.value.length;
              input.setRangeText(text, s, e, "end");
              input.dispatchEvent(new Event("input", { bubbles: true }));
            } else {
              document.execCommand("insertText", false, text);
            }
          })
          .catch(() => {});
      },
    },
    "separator",
    {
      label: "Select all",
      onClick: () => {
        field.focus();
        if (input) input.select();
        else document.execCommand("selectAll");
      },
    },
  ];
}

/** Mounts once around the app. Renders the active menu (position: fixed,
 *  above overlays) and fully replaces the native webview context menu: text
 *  fields get a Cut/Copy/Paste/Select-all menu, everything else gets the
 *  caller's custom items (or, for unwired elements with a text selection, a
 *  bare Copy). The native menu never appears. */
export function ContextMenuProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [menu, setMenu] = useState<MenuState | null>(null);

  const open = useCallback<OpenMenuFn>((e, items) => {
    e.preventDefault();
    e.stopPropagation();
    const field = closestTextField(e.target);
    const finalItems = field ? buildTextFieldMenu(field) : items;
    if (!finalItems.some((it) => it !== "separator")) return;
    setMenu({ x: e.clientX, y: e.clientY, items: finalItems });
  }, []);

  useEffect(() => {
    // Fallback for elements with no onContextMenu of their own — open()
    // above already handles anything wired (and stops propagation, so this
    // never double-fires for those).
    const onCtx = (e: MouseEvent) => {
      e.preventDefault();
      const field = closestTextField(e.target);
      if (field) {
        setMenu({ x: e.clientX, y: e.clientY, items: buildTextFieldMenu(field) });
        return;
      }
      if (hasSelection()) {
        setMenu({
          x: e.clientX,
          y: e.clientY,
          items: [{ label: "Copy", icon: "Copy", onClick: () => document.execCommand("copy") }],
        });
      }
      // Otherwise: nothing sensible to offer — just suppressed, no menu.
    };
    document.addEventListener("contextmenu", onCtx);
    return () => document.removeEventListener("contextmenu", onCtx);
  }, []);

  return (
    <MenuCtx.Provider value={open}>
      {children}
      {menu && <MenuPanel key={`${menu.x}:${menu.y}`} state={menu} onClose={() => setMenu(null)} />}
    </MenuCtx.Provider>
  );
}

function MenuPanel({ state, onClose }: Readonly<{ state: MenuState; onClose: () => void }>) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // Whether submenus should open to the left because the menu sits near the
  // right viewport edge.
  const [flipSub, setFlipSub] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(4, Math.min(state.x, globalThis.innerWidth - r.width - 8));
    const top = Math.max(4, Math.min(state.y, globalThis.innerHeight - r.height - 8));
    setPos({ left, top });
    setFlipSub(left + r.width + 200 > globalThis.innerWidth);
  }, [state]);

  useEffect(() => {
    const swallowClick = (ce: MouseEvent) => {
      ce.stopPropagation();
      ce.preventDefault();
    };
    const onDown = (ev: MouseEvent) => {
      if (ref.current && !ref.current.contains(ev.target as Node)) {
        onClose();
        // Native menus swallow the dismissing click — do the same so
        // clicking away doesn't also activate the control underneath.
        // Right/middle buttons produce no `click`, so only trap primary.
        if (ev.button === 0) {
          document.addEventListener("click", swallowClick, { capture: true, once: true });
          globalThis.setTimeout(
            () => document.removeEventListener("click", swallowClick, true),
            300,
          );
        }
      }
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onClose();
    };
    // Close on USER scrolling only (wheel/touch outside the menu). A plain
    // capture-phase "scroll" listener would also fire for the chat thread's
    // programmatic auto-scroll during streaming, closing the menu — which
    // would make its "Stop generating" item unclickable.
    const onWheel = (ev: Event) => {
      if (ref.current && ev.target instanceof Node && ref.current.contains(ev.target)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    document.addEventListener("wheel", onWheel, true);
    document.addEventListener("touchmove", onWheel, true);
    globalThis.addEventListener("resize", onClose);
    globalThis.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("wheel", onWheel, true);
      document.removeEventListener("touchmove", onWheel, true);
      document.removeEventListener("click", swallowClick, true);
      globalThis.removeEventListener("resize", onClose);
      globalThis.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      style={
        pos
          ? { left: pos.left, top: pos.top }
          : { left: state.x, top: state.y, visibility: "hidden" }
      }
    >
      <ItemList items={state.items} onClose={onClose} flipSub={flipSub} />
    </div>
  );
}

// Submenu panel that corrects its own position after mount: flips to the
// left edge when it would overflow the right viewport edge (the parent's
// flip estimate uses a width guess), and shifts up when it would run past
// the bottom.
function SubMenu({
  items,
  onClose,
  flip,
}: Readonly<{ items: MenuItem[]; onClose: () => void; flip: boolean }>) {
  const ref = useRef<HTMLDivElement>(null);
  const [flipped, setFlipped] = useState(flip);
  const [shiftY, setShiftY] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (!flipped && r.right > globalThis.innerWidth - 8) setFlipped(true);
    const over = r.bottom - (globalThis.innerHeight - 8);
    if (over > 0) setShiftY(-over);
    // Measure once on mount — items don't change while open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={ref}
      className={"ctx-menu ctx-submenu" + (flipped ? " flip" : "")}
      role="menu"
      style={shiftY ? { transform: `translateY(${shiftY}px)` } : undefined}
    >
      <ItemList items={items} onClose={onClose} flipSub={flipped} />
    </div>
  );
}

function ItemList({
  items,
  onClose,
  flipSub,
}: Readonly<{ items: MenuItem[]; onClose: () => void; flipSub: boolean }>) {
  const [subIdx, setSubIdx] = useState<number | null>(null);

  return (
    <>
      {items.map((it, i) => {
        const key = it === "separator" ? `sep-${i}` : `${it.label}-${i}`;
        if (it === "separator") {
          return <div key={key} className="ctx-sep" />;
        }
        const Ico = it.icon ? I[it.icon] : null;
        const hasSub = !!it.submenu?.length;
        return (
          <div
            key={key}
            className="ctx-item-wrap"
            onMouseEnter={() => setSubIdx(hasSub ? i : null)}
          >
            <button
              type="button"
              role="menuitem"
              className={
                "ctx-item" +
                (it.danger ? " danger" : "") +
                (it.disabled ? " disabled" : "") +
                (hasSub && subIdx === i ? " sub-open" : "")
              }
              // Cut/Copy act on the selection captured when the menu opened —
              // clicking a button would otherwise clear that selection before
              // onClick runs (mousedown outside the selection collapses it).
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                if (it.disabled || hasSub) return;
                onClose();
                it.onClick?.();
              }}
            >
              <span className="ctx-ico">{Ico ? <Ico size={13} /> : null}</span>
              <span className="ctx-label">{it.label}</span>
              {it.hint && <span className="ctx-hint">{it.hint}</span>}
              {hasSub && <I.ChevR size={11} style={{ color: "var(--muted)", flexShrink: 0 }} />}
            </button>
            {hasSub && subIdx === i && (
              <SubMenu items={it.submenu ?? []} onClose={onClose} flip={flipSub} />
            )}
          </div>
        );
      })}
    </>
  );
}
