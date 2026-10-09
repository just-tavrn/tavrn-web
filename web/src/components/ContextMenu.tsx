// SPDX-License-Identifier: Apache-2.0
/**
 * Context menus (design note 4.11): one generic menu for members, messages, channels, rooms and DMs. Opened by
 * a right-click (`contextmenu`, the browser menu is suppressed), by the keyboard (context-menu key or
 * Shift+F10 on a focused trigger), by a "⋯" button ({@link MenuButton}) and by a long press on touch
 * devices. Rendered into `document.body` (never clipped by a scrolling or transformed parent), placed
 * with collision handling (`lib/position.ts`), closed by Escape, Tab, a click outside or a choice.
 * Keyboard: arrows move, Home/End jump, Enter/Space choose, → opens a submenu, ← closes it; ↑/↓ also reach the
 * control of a custom entry (a slider), which keeps its own keys. Disabled items stay focusable and carry the
 * reason as a tooltip (and for screen readers).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type TouchEvent as ReactTouchEvent } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";
import { pointAnchor, rectOf, useFloating, type AnchorRect } from "../lib/position";

export interface MenuItem {
  kind: "item";
  id: string;
  label: string;
  icon?: ReactNode;
  onSelect?: () => void;
  /** Destructive actions are shown in red. */
  danger?: boolean;
  disabled?: boolean;
  /** Why the item is disabled (tooltip). */
  reason?: string;
  /** A checkbox item (roles, toggles); `undefined` = plain item. */
  checked?: boolean;
  /** Keep the menu open after choosing (checkbox lists). */
  keepOpen?: boolean;
  /** Short text on the right (shortcut, current value). */
  hint?: string;
  /** Show the hint as a count badge (open reports). */
  hintBadge?: boolean;
  /** Accessible name when the label alone is not enough (a count in the hint). */
  ariaLabel?: string;
  /** Test id of the item's button. */
  testId?: string;
}

export interface MenuSubmenu {
  kind: "submenu";
  id: string;
  label: string;
  icon?: ReactNode;
  items: MenuEntry[];
  disabled?: boolean;
  reason?: string;
  hint?: string;
}

export interface MenuSeparator {
  kind: "separator";
  id: string;
}

export interface MenuLabel {
  kind: "label";
  id: string;
  label: string;
}

/** Free content (a volume slider); it gets the close function. */
export interface MenuCustom {
  kind: "custom";
  id: string;
  render: (close: () => void) => ReactNode;
}

export type MenuEntry = MenuItem | MenuSubmenu | MenuSeparator | MenuLabel | MenuCustom;

/** Builders keep the menu definitions short. */
export const menuItem = (id: string, label: string, onSelect: (() => void) | undefined, opts: Partial<Omit<MenuItem, "kind" | "id" | "label" | "onSelect">> = {}): MenuItem => ({ kind: "item", id, label, onSelect, ...opts });
export const submenu = (id: string, label: string, items: Array<MenuEntry | false | null | undefined>, opts: Partial<Omit<MenuSubmenu, "kind" | "id" | "label" | "items">> = {}): MenuSubmenu => ({ kind: "submenu", id, label, items: normalizeMenu(items), ...opts });
export const separator = (id: string): MenuSeparator => ({ kind: "separator", id });
export const menuLabel = (id: string, label: string): MenuLabel => ({ kind: "label", id, label });

/**
 * Drops falsy entries (conditional items), empty submenus and separators at the start, at the end and
 * next to each other.
 */
export function normalizeMenu(entries: Array<MenuEntry | false | null | undefined>): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const e of entries) {
    if (!e) continue;
    if (e.kind === "submenu" && e.items.length === 0) continue;
    if (e.kind === "separator" && (out.length === 0 || out[out.length - 1]!.kind === "separator")) continue;
    out.push(e);
  }
  while (out.length && out[out.length - 1]!.kind === "separator") out.pop();
  return out;
}

/** Entries that take keyboard focus. */
const focusable = (e: MenuEntry): e is MenuItem | MenuSubmenu => e.kind === "item" || e.kind === "submenu";
/** Stops of the arrow keys: the items and the custom entries (their first control). */
type Stop = MenuItem | MenuSubmenu | MenuCustom;
const isStop = (e: MenuEntry): e is Stop => focusable(e) || e.kind === "custom";
/** The focusable control inside a custom entry. */
const CONTROL = "input, select, textarea, button, [tabindex]";
/** Keys a focused custom control handles itself (a slider moves with them). */
const CONTROL_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", " ", "Enter"]);

/** Finds an entry by id path (tests). */
export function findEntry(entries: MenuEntry[], id: string): MenuItem | MenuSubmenu | undefined {
  for (const e of entries) {
    if (focusable(e) && e.id === id) return e;
    if (e.kind === "submenu") {
      const inner = findEntry(e.items, id);
      if (inner) return inner;
    }
  }
  return undefined;
}

// ---- Rendering ------------------------------------------------------------------------------

const ITEM = "flex min-h-9 w-full items-center gap-2 rounded px-2 text-left text-sm outline-none";
/** How long after opening a panel ignores hover (the release of the long press that opened it). */
const SETTLE_MS = 350;

function MenuPanel({ entries, anchor, prefer, onClose, onCloseSub, label, depth, testId }: { entries: MenuEntry[]; anchor: AnchorRect; prefer: "bottom" | "right"; onClose: () => void; onCloseSub?: () => void; label?: string; depth: number; testId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const style = useFloating(ref, anchor, { prefer, gap: prefer === "right" ? 0 : 2 }, [entries.length]);
  const items = useMemo(() => entries.filter(isStop), [entries]);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState<{ id: string; anchor: AnchorRect } | null>(null);
  const buttons = useRef<Record<string, HTMLElement | null>>({});
  /** The element that takes focus for a stop: the item's button or the custom entry's control. */
  const stopElement = (e: Stop | undefined): HTMLElement | null => {
    if (!e) return null;
    const el = buttons.current[e.id] ?? null;
    return e.kind === "custom" ? (el?.querySelector<HTMLElement>(CONTROL) ?? null) : el;
  };
  // A menu opened by a long press sits under the finger: the compatibility mouse move of the release would hover
  // whatever item lies there (and open its submenu). Hover counts only once the panel has settled; clicks and the
  // keyboard work right away.
  const settled = useRef(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      settled.current = true;
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, []);

  const focused = useRef(false);
  useLayoutEffect(() => {
    // Focus the first enabled item once the panel is placed (hidden elements cannot take focus).
    if (focused.current || style.visibility !== "visible") return;
    focused.current = true;
    const first = Math.max(0, items.findIndex((e) => e.kind !== "custom" && !e.disabled));
    setActive(first);
    stopElement(items[first])?.focus({ preventScroll: true });
    // Only when the panel becomes visible.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [style.visibility]);

  const focusIndex = (i: number) => {
    const n = items.length;
    if (!n) return;
    const next = ((i % n) + n) % n;
    setActive(next);
    stopElement(items[next])?.focus({ preventScroll: true });
  };

  const openSub = (entry: MenuSubmenu) => {
    const el = buttons.current[entry.id];
    if (!el || entry.disabled) return;
    setOpen({ id: entry.id, anchor: rectOf(el) });
  };

  const choose = (entry: MenuItem | MenuSubmenu) => {
    if (entry.disabled) return;
    if (entry.kind === "submenu") return openSub(entry);
    entry.onSelect?.();
    if (!entry.keepOpen) onClose();
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    // Keys inside a submenu are handled there.
    if (e.target instanceof HTMLElement && e.target.closest("[data-menu-depth]") !== ref.current) return;
    // A custom entry's control (a slider) keeps its own keys; type-ahead does not apply there either.
    const inCustom = e.target instanceof HTMLElement && !!e.target.closest("[data-menu-custom]");
    if (inCustom && (CONTROL_KEYS.has(e.key) || e.key.length === 1)) return;
    const current = items[active];
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        focusIndex(active + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        focusIndex(active - 1);
        break;
      case "Home":
        e.preventDefault();
        focusIndex(0);
        break;
      case "End":
        e.preventDefault();
        focusIndex(items.length - 1);
        break;
      case "ArrowRight":
        if (current?.kind === "submenu") {
          e.preventDefault();
          openSub(current);
        }
        break;
      case "ArrowLeft":
        if (depth > 0) {
          e.preventDefault();
          onCloseSub?.();
        }
        break;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        if (depth > 0) onCloseSub?.();
        else onClose();
        break;
      case "Tab":
        e.preventDefault();
        onClose();
        break;
      default:
        // Type-ahead: the next item starting with the typed letter.
        if (e.key.length === 1 && /\S/.test(e.key)) {
          const k = e.key.toLowerCase();
          for (let i = 1; i <= items.length; i++) {
            const idx = (active + i) % items.length;
            const candidate = items[idx]!;
            if (candidate.kind !== "custom" && candidate.label.toLowerCase().startsWith(k)) {
              focusIndex(idx);
              break;
            }
          }
        }
    }
  };

  const sub = open ? (entries.find((e) => e.kind === "submenu" && e.id === open.id) as MenuSubmenu | undefined) : undefined;
  return (
    <>
      <div
        ref={ref}
        role="menu"
        aria-label={label}
        data-menu-depth={depth}
        data-testid={depth === 0 ? (testId ?? "context-menu") : "context-submenu"}
        className="z-[70] min-w-52 overflow-y-auto rounded-lg border border-line bg-bg-1 p-1 shadow-xl"
        style={style}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => e.preventDefault()}
      >
        {entries.map((e) => {
          if (e.kind === "separator") return <div key={e.id} role="separator" className="my-1 h-px bg-line" />;
          if (e.kind === "label") return <div key={e.id} className="px-2 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-2">{e.label}</div>;
          const index = items.indexOf(e);
          if (e.kind === "custom")
            return (
              <div
                key={e.id}
                ref={(el) => {
                  buttons.current[e.id] = el;
                }}
                className="px-2 py-1"
                data-menu-custom={e.id}
                onFocus={() => setActive(index)}
              >
                {e.render(onClose)}
              </div>
            );
          const tone = e.disabled ? "cursor-not-allowed text-fg-2 opacity-60" : e.kind === "item" && e.danger ? "text-danger hover:bg-danger/10 focus:bg-danger/10" : "text-fg-1 hover:bg-bg-3 hover:text-fg-0 focus:bg-bg-3 focus:text-fg-0";
          const role = e.kind === "item" && e.checked !== undefined ? "menuitemcheckbox" : "menuitem";
          return (
            <button
              key={e.id}
              ref={(el) => {
                buttons.current[e.id] = el;
              }}
              type="button"
              role={role}
              tabIndex={index === active ? 0 : -1}
              aria-disabled={e.disabled || undefined}
              aria-checked={e.kind === "item" && e.checked !== undefined ? e.checked : undefined}
              aria-haspopup={e.kind === "submenu" ? "menu" : undefined}
              aria-expanded={e.kind === "submenu" ? open?.id === e.id : undefined}
              aria-description={e.disabled && e.reason ? e.reason : undefined}
              title={e.disabled ? e.reason : undefined}
              aria-label={e.kind === "item" ? e.ariaLabel : undefined}
              data-menu-item={e.id}
              data-testid={e.kind === "item" ? e.testId : undefined}
              className={`${ITEM} ${tone}`}
              onMouseEnter={() => {
                if (!settled.current) return;
                setActive(index);
                if (e.kind === "submenu") openSub(e);
                else if (open) setOpen(null);
              }}
              onFocus={() => setActive(index)}
              onClick={(ev) => {
                ev.stopPropagation();
                choose(e);
              }}
            >
              {e.kind === "item" && e.checked !== undefined ? (
                <span aria-hidden="true" className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] ${e.checked ? "border-accent bg-accent text-accent-text" : "border-line"}`}>
                  {e.checked ? "✓" : ""}
                </span>
              ) : (
                <span aria-hidden="true" className="flex w-4 shrink-0 justify-center">
                  {e.icon}
                </span>
              )}
              <span className="min-w-0 flex-1 truncate">{e.label}</span>
              {e.hint && (e.kind === "item" && e.hintBadge ? <span className="min-w-4 shrink-0 rounded-full bg-danger-solid px-1 text-center text-[10px] font-semibold leading-4 text-white">{e.hint}</span> : <span className="shrink-0 text-xs text-fg-2">{e.hint}</span>)}
              {e.kind === "submenu" && <span aria-hidden="true" className="shrink-0 text-fg-2">›</span>}
            </button>
          );
        })}
      </div>
      {sub && open && (
        <MenuPanel
          key={sub.id}
          entries={sub.items}
          anchor={open.anchor}
          prefer="right"
          label={sub.label}
          depth={depth + 1}
          onClose={onClose}
          onCloseSub={() => {
            setOpen(null);
            buttons.current[sub.id]?.focus({ preventScroll: true });
          }}
        />
      )}
    </>
  );
}

/**
 * A menu at `anchor` (a point or an element's rectangle). Focus returns to the element that had it
 * before the menu opened.
 */
export function ContextMenu({ entries, anchor, onClose, label, testId, trigger }: { entries: MenuEntry[]; anchor: AnchorRect; onClose: () => void; label?: string; testId?: string; trigger?: Element | null }) {
  const layer = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const triggerRef = useRef(trigger);
  triggerRef.current = trigger;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const outside = (e: Event) => {
      const target = e.target as Node;
      if (layer.current?.contains(target)) return;
      // A toggling trigger (`useContextMenu({ toggle: true })`) closes the menu itself on its next right-click.
      const secondary = e.type === "contextmenu" || (e as PointerEvent).button === 2;
      if (secondary && triggerRef.current?.contains(target)) return;
      onCloseRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    // Registered after the opening event has finished, so the same click does not close it again.
    const timer = setTimeout(() => {
      document.addEventListener("pointerdown", outside, true);
      document.addEventListener("contextmenu", outside, true);
    }, 0);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onCloseRef.current);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("contextmenu", outside, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onCloseRef.current);
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, []);
  if (entries.length === 0) return null;
  return createPortal(
    <div ref={layer} data-context-menu-layer>
      <MenuPanel entries={entries} anchor={anchor} prefer="bottom" onClose={onClose} label={label} depth={0} testId={testId} />
    </div>,
    document.body,
  );
}

/** Events from a portal (the open menu) bubble through the React tree but not through the DOM. */
const fromPortal = (e: { currentTarget: EventTarget; target: EventTarget }) => !(e.currentTarget as Node).contains(e.target as Node);

/** Milliseconds of a touch without moving that count as a long press. */
export const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE = 10;

export interface ContextMenuTrigger {
  anchor: AnchorRect | null;
  open: boolean;
  close: () => void;
  /** Opens the menu at an element (the ⋯ button). */
  openAt: (el: Element) => void;
  /** With `toggle`: the element whose right-click opened the menu (pass it to {@link ContextMenu} as `trigger`). */
  trigger: Element | null;
  /** Spread onto the element that has the menu. */
  triggerProps: {
    onContextMenu: (e: ReactMouseEvent) => void;
    onTouchStart: (e: ReactTouchEvent) => void;
    onTouchMove: (e: ReactTouchEvent) => void;
    onTouchEnd: (e: ReactTouchEvent) => void;
    onTouchCancel: () => void;
    onClickCapture: (e: ReactMouseEvent) => void;
    style: { WebkitTouchCallout: "none" };
  };
}

/**
 * State and handlers for an element with a context menu: right-click at the pointer, the keyboard's
 * context-menu key at the element, a long press on touch (the click that follows is swallowed). By default a
 * right-click while the menu is open opens it again at the new point; with `toggle` a right-click on the same
 * element closes it (menus that stay open after a choice: the voice device menus).
 */
export function useContextMenu({ toggle = false }: { toggle?: boolean } = {}): ContextMenuTrigger {
  const [anchor, setAnchorState] = useState<AnchorRect | null>(null);
  // The anchor as of the last change, readable inside one event (the state updates later).
  const current = useRef<AnchorRect | null>(null);
  const setAnchor = useCallback((a: AnchorRect | null) => {
    current.current = a;
    setAnchorState(a);
  }, []);
  const [trigger, setTrigger] = useState<Element | null>(null);
  const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout>; target: Element } | null>(null);
  const swallowClick = useRef(false);
  const cancel = useCallback(() => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);
  const close = useCallback(() => setAnchor(null), [setAnchor]);
  const openAt = useCallback((el: Element) => setAnchor(rectOf(el)), [setAnchor]);
  const triggerProps = useMemo<ContextMenuTrigger["triggerProps"]>(
    () => ({
      onContextMenu: (e) => {
        // Inside an open menu, or a nested element with its own menu that handled it already.
        if (e.defaultPrevented || fromPortal(e)) return;
        e.preventDefault();
        e.stopPropagation();
        if (toggle && current.current) return setAnchor(null);
        if (toggle) setTrigger(e.currentTarget);
        // Keyboard (context-menu key, Shift+F10): no pointer position, use the element.
        if (e.clientX === 0 && e.clientY === 0) setAnchor(rectOf(e.currentTarget));
        else setAnchor(pointAnchor(e.clientX, e.clientY));
      },
      onTouchStart: (e) => {
        if (fromPortal(e)) return;
        const touch = e.touches[0];
        if (!touch || e.touches.length > 1) return cancel();
        cancel();
        const target = e.currentTarget;
        press.current = {
          x: touch.clientX,
          y: touch.clientY,
          target,
          timer: setTimeout(() => {
            const p = press.current;
            press.current = null;
            if (!p) return;
            swallowClick.current = true;
            if (toggle) setTrigger(p.target);
            setAnchor(pointAnchor(p.x, p.y));
            navigator.vibrate?.(10);
          }, LONG_PRESS_MS),
        };
      },
      onTouchMove: (e) => {
        const touch = e.touches[0];
        const p = press.current;
        if (!touch || !p) return;
        if (Math.abs(touch.clientX - p.x) > MOVE_TOLERANCE || Math.abs(touch.clientY - p.y) > MOVE_TOLERANCE) cancel();
      },
      onTouchEnd: (e) => {
        cancel();
        // The long press opened the menu: no click (navigation) afterwards.
        if (swallowClick.current) {
          e.preventDefault();
          setTimeout(() => (swallowClick.current = false), 400);
        }
      },
      onTouchCancel: cancel,
      onClickCapture: (e) => {
        // Clicks inside the (portaled) menu reach this element through the React tree: never swallow those.
        if (!swallowClick.current || fromPortal(e)) return;
        swallowClick.current = false;
        e.preventDefault();
        e.stopPropagation();
      },
      style: { WebkitTouchCallout: "none" },
    }),
    [cancel, setAnchor, toggle],
  );
  return { anchor, open: anchor !== null, close, openAt, trigger: toggle ? trigger : null, triggerProps };
}

/** The "⋯" button that opens a menu (touch, keyboard, discoverability). */
export function MenuButton({ menu, label, className = "", testId }: { menu: ContextMenuTrigger; label: string; className?: string; testId?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-haspopup="menu"
      aria-expanded={menu.open}
      data-testid={testId ?? "menu-button"}
      className={`min-h-8 min-w-8 shrink-0 rounded text-fg-2 hover:bg-bg-3 hover:text-fg-0 ${className}`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (menu.open) menu.close();
        else menu.openAt(e.currentTarget);
      }}
    >
      ⋯
    </button>
  );
}

/** A copy helper for menu actions (clipboard, with a toast by the caller). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** The default label of a menu (screen readers). */
export function useMenuLabel(name: string): string {
  const t = useT();
  return t("menu.label", { name });
}
