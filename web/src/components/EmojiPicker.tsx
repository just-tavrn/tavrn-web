// SPDX-License-Identifier: Apache-2.0
/**
 * The emoji picker (design note 4.13) for the composer and reactions: quick reactions, recently used, the
 * current room's emojis, personal emojis, emojis of the other rooms (grouped by room) and the Unicode set
 * from emojibase in categories, with search over everything, a skin tone choice and keyboard navigation
 * (arrow keys move in the grid, typing jumps into the search, Escape closes).
 *
 * Emojis that are not the current room's own need `use_external_emojis` in the channel (DMs: always): without
 * it they are shown greyed out with a tooltip naming the missing permission. The Unicode data, the other
 * rooms and the personal emojis load on the first open.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLocale, useT } from "../i18n";
import { GROUP_ICONS, GROUP_KEYS, loadEmojiData, matchScore, normalizeQuery, recentEmojis, rememberEmoji, searchEmojis, setSkinTone, skinTone, withTone, type EmojiData } from "../lib/emojiData";
import { emojiImageUrl, useEmojiContext, useOtherEmojis, type PickerEmoji } from "../lib/emojis";
import { emojiToken, parseEmojiToken } from "../lib/markdown";
import { useNode } from "./NodeScope";
import { useDismiss } from "../lib/dismiss";
import { rovingKeyDown } from "../lib/a11y";

export const QUICK_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🔥", "🎉", "👀"];

/** A custom emoji of the room as the views pass it. */
export interface CustomEmoji {
  id: string;
  name: string;
  roomId: string;
  animated?: boolean;
}

/** Width and gap of the picker popup (px). */
export const MENU_WIDTH = 336;
/**
 * Height of the picker popup (px), fixed: the content loads in steps (Unicode data, other rooms' emojis,
 * categories frame by frame), and a popup that grew with it would leave the place it was measured for.
 * On short viewports the popup is bounded by the viewport; the grid scrolls inside.
 */
export const MENU_HEIGHT = 384;
const MENU_GAP = 4;
const COLUMNS = 8;
const TONE_GLYPHS = ["✋", "✋🏻", "✋🏼", "✋🏽", "✋🏾", "✋🏿"];

/**
 * Where the popup goes: right-aligned to the button, below it, or above it when there is no room below;
 * always inside the viewport (when neither side fits, it starts at the top edge).
 */
export function pickerPosition(button: { top: number; bottom: number; right: number }, menuHeight: number, viewport: { width: number; height: number }) {
  const width = Math.min(MENU_WIDTH, viewport.width - 2 * MENU_GAP);
  const left = Math.max(MENU_GAP, Math.min(button.right - width, viewport.width - width - MENU_GAP));
  const below = button.bottom + MENU_GAP;
  const top = below + menuHeight <= viewport.height - MENU_GAP ? below : Math.max(MENU_GAP, button.top - MENU_GAP - menuHeight);
  return { top, left };
}

interface Item {
  key: string;
  /** What `onPick` receives. */
  value: string;
  label: string;
  /** The picture; `active` while hovered or focused (custom emojis animate then). */
  glyph: (active: boolean) => ReactNode;
  disabled?: boolean;
  title?: string;
  /** Picks remembered in "recently used". */
  remember?: boolean;
}

interface Section {
  id: string;
  title: string;
  icon: string;
  items: Item[];
}

/** A custom emoji image: the still frame until hovered or focused; `onMissing` when its bytes are gone. */
function CustomGlyph({ e, active, onMissing }: { e: PickerEmoji; active: boolean; onMissing?: () => void }) {
  return <img src={emojiImageUrl(e.node, e.id, e.animated && !active, e.origin)} alt="" className="h-7 w-7 object-contain" loading="lazy" draggable={false} onError={onMissing} />;
}

function PickerButton({ item, index, focused, onFocus, onPick }: { item: Item; index: number; focused: boolean; onFocus: (i: number) => void; onPick: (item: Item) => void }) {
  const [active, setActive] = useState(false);
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={focused ? 0 : -1}
      data-index={index}
      aria-label={item.label}
      aria-disabled={item.disabled || undefined}
      title={item.title ?? item.label}
      onFocus={() => {
        onFocus(index);
        setActive(true);
      }}
      onBlur={() => setActive(false)}
      onMouseEnter={() => setActive(true)}
      onMouseLeave={() => setActive(false)}
      onClick={() => onPick(item)}
      className={`flex h-9 w-9 items-center justify-center rounded text-2xl leading-none ${item.disabled ? "cursor-not-allowed opacity-35 grayscale" : "hover:bg-bg-3 focus-visible:bg-bg-3"}`}
      data-testid="emoji-option"
    >
      {item.glyph(active)}
    </button>
  );
}

/** Custom emoji items (animated while hovered). */
function useCustomItems(list: PickerEmoji[], value: (e: PickerEmoji) => string, disabled: boolean, title: string | undefined): Item[] {
  return useMemo(
    () => list.map((e) => ({ key: `${e.source}:${e.id}`, value: value(e), label: `:${e.name}:`, glyph: (active: boolean) => <CustomGlyph e={e} active={active} />, disabled, title: disabled ? title : `:${e.name}:${e.roomName ? ` · ${e.roomName}` : ""}`, remember: true })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [list, disabled, title],
  );
}

function PickerPanel({ onPick, customEmojis }: { onPick: (emoji: string) => void; customEmojis: CustomEmoji[] }) {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const ctx = useEmojiContext();
  const { domain } = useNode();
  const conversationNode = ctx?.domain ?? domain;
  const external = ctx ? ctx.externalAllowed : true;
  const [query, setQuery] = useState("");
  const [tone, setTone] = useState(skinTone);
  const [data, setData] = useState<EmojiData | null>(null);
  const [failed, setFailed] = useState(false);
  const [recents, setRecents] = useState(recentEmojis);
  const [focus, setFocus] = useState(0);
  // Recently used custom emojis whose bytes are gone everywhere are not offered (design note 4.13).
  const [missing, setMissing] = useState<ReadonlySet<string>>(() => new Set());
  const [rendered, setRendered] = useState(4);
  const search = useRef<HTMLInputElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const others = useOtherEmojis(ctx?.roomId, true);

  useEffect(() => {
    let cancelled = false;
    loadEmojiData(locale)
      .then((d) => !cancelled && setData(d))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [locale]);

  // The room's emojis: from the conversation context, else from the caller (older views).
  const roomList: PickerEmoji[] = useMemo(
    () => (ctx?.roomEmojis.length ? ctx.roomEmojis.map((e) => ({ id: e.id, name: e.name, animated: !!e.animated, node: conversationNode, source: "room" as const, roomId: ctx.roomId })) : customEmojis.map((e) => ({ id: e.id, name: e.name, animated: !!e.animated, node: conversationNode, source: "room" as const, roomId: e.roomId }))),
    [ctx, customEmojis, conversationNode],
  );
  const roomIds = useMemo(() => new Set(roomList.map((e) => e.id)), [roomList]);
  const deniedTitle = external ? undefined : t("emoji_picker.external_denied");
  const tokenFor = (e: PickerEmoji) => emojiToken(e.name, e.id, e.node, conversationNode);
  const roomItems = useCustomItems(roomList, (e) => `:${e.name}:`, false, undefined);
  const personalItems = useCustomItems(others.personal, tokenFor, !external, deniedTitle);
  const otherItems = useCustomItems(others.other, tokenFor, !external, deniedTitle);

  const unicodeItem = (u: string, label: string, key: string): Item => ({ key, value: u, label, glyph: () => <span aria-hidden="true" className="emoji-font">{u}</span>, remember: true });

  const sections: Section[] = useMemo(() => {
    const out: Section[] = [];
    if (query.trim()) {
      const q = normalizeQuery(query);
      const custom = [...roomItems, ...personalItems, ...otherItems].filter((i) => matchScore(i.label.slice(1, -1), q) > 0);
      const unicode = data ? searchEmojis(data, query).map((e) => unicodeItem(withTone(e, tone), e.label, `u:${e.unicode}`)) : [];
      out.push({ id: "results", title: t("emoji_picker.results"), icon: "🔎", items: [...custom, ...unicode] });
      return out;
    }
    out.push({ id: "quick", title: t("emoji_picker.quick"), icon: "⚡", items: QUICK_EMOJIS.map((e) => ({ key: `q:${e}`, value: e, label: e, glyph: () => <span aria-hidden="true">{e}</span>, remember: true })) });
    const recentItems = recents
      .map((r): Item | null => {
        const token = parseEmojiToken(r);
        if (token) {
          if (missing.has(token.id)) return null;
          const own = !token.host && roomIds.has(token.id);
          // Loaded through the conversation's node (its cached copy for other nodes' emojis).
          const e: PickerEmoji = { id: token.id, name: token.name, animated: false, node: conversationNode, origin: token.host, source: own ? "room" : "other" };
          const disabled = !own && !external;
          const gone = () => setMissing((m) => new Set([...m, token.id]));
          return { key: `r:${r}`, value: r, label: `:${token.name}:`, glyph: (active: boolean) => <CustomGlyph e={e} active={active} onMissing={gone} />, disabled, title: disabled ? deniedTitle : `:${token.name}:`, remember: true };
        }
        if (r.startsWith(":")) {
          const e = roomList.find((x) => `:${x.name}:` === r);
          return e ? { key: `r:${r}`, value: r, label: r, glyph: (active: boolean) => <CustomGlyph e={e} active={active} />, remember: true } : null;
        }
        return unicodeItem(r, r, `r:${r}`);
      })
      .filter((x): x is Item => !!x);
    if (recentItems.length) out.push({ id: "recent", title: t("emoji_picker.recent"), icon: "🕘", items: recentItems });
    if (roomItems.length) out.push({ id: "room", title: t("emoji_picker.room"), icon: "🏠", items: roomItems });
    if (personalItems.length) out.push({ id: "personal", title: t("emoji_picker.personal"), icon: "⭐", items: personalItems });
    const byRoom = new Map<string, Item[]>();
    others.other.forEach((e, i) => {
      const key = `${e.roomName ?? "?"}\u0000${e.roomId}`;
      byRoom.set(key, [...(byRoom.get(key) ?? []), otherItems[i]!]);
    });
    for (const [key, items] of byRoom) out.push({ id: `other:${key.split("\u0000")[1]}`, title: key.split("\u0000")[0]!, icon: "🧩", items });
    if (data) {
      data.groups.forEach((list, g) => {
        if (list.length) out.push({ id: `g:${g}`, title: t(`emoji_picker.group.${GROUP_KEYS[g]}`), icon: GROUP_ICONS[g]!, items: list.map((e) => unicodeItem(withTone(e, tone), e.label, `u:${e.unicode}`)) });
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, data, tone, recents, roomItems, personalItems, otherItems, external, t, missing]);

  // Chunked rendering: the first sections paint at once, the long Unicode categories follow frame by frame.
  useEffect(() => {
    if (rendered >= sections.length) return;
    const id = requestAnimationFrame(() => setRendered((n) => n + 2));
    return () => cancelAnimationFrame(id);
  }, [rendered, sections.length]);

  const visible = sections.slice(0, query ? sections.length : rendered);
  const flat = visible.flatMap((s) => s.items);
  const focusIndex = Math.min(focus, Math.max(0, flat.length - 1));
  useEffect(() => setFocus(0), [query]);

  const pick = (item: Item) => {
    if (item.disabled) return;
    if (item.remember) setRecents(rememberEmoji(item.value));
    onPick(item.value);
  };

  const move = (to: number) => {
    const next = Math.max(0, Math.min(flat.length - 1, to));
    setFocus(next);
    grid.current?.querySelector<HTMLElement>(`[data-index="${next}"]`)?.focus();
  };

  const onGridKey = (e: React.KeyboardEvent) => {
    const keys: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLUMNS, ArrowUp: -COLUMNS };
    if (e.key in keys) {
      e.preventDefault();
      if (e.key === "ArrowUp" && focusIndex < COLUMNS) return search.current?.focus();
      move(focusIndex + keys[e.key]!);
    } else if (e.key === "Home") {
      e.preventDefault();
      move(0);
    } else if (e.key === "End") {
      e.preventDefault();
      move(flat.length - 1);
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== " ") {
      // Typing searches.
      e.preventDefault();
      setQuery((q) => q + e.key);
      search.current?.focus();
    }
  };

  let index = 0;
  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-line p-2">
        <input
          ref={search}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              move(0);
            } else if (e.key === "Enter" && flat[0]) {
              e.preventDefault();
              pick(flat[0]);
            }
          }}
          placeholder={t("emoji_picker.search")}
          aria-label={t("emoji_picker.search")}
          className="min-h-9 min-w-0 flex-1 rounded-md border border-line-strong bg-bg-0 px-2 text-sm text-fg-0 outline-none focus:border-accent"
          data-testid="emoji-search"
        />
        <select
          value={tone}
          onChange={(e) => {
            const v = Number(e.target.value);
            setTone(v);
            setSkinTone(v);
          }}
          aria-label={t("emoji_picker.skin_tone")}
          title={t("emoji_picker.skin_tone")}
          className="min-h-9 rounded-md border border-line-strong bg-bg-0 px-1 text-lg"
          data-testid="emoji-skin-tone"
        >
          {TONE_GLYPHS.map((g, i) => (
            <option key={g} value={i}>
              {g}
            </option>
          ))}
        </select>
      </div>
      {!query && (
        // One tab stop for the section buttons; arrow keys move between them (roving focus).
        <nav className="flex shrink-0 select-none gap-0.5 overflow-x-auto border-b border-line px-1 py-1" aria-label={t("emoji_picker.sections")} onKeyDown={(e) => rovingKeyDown(e, "button", { orientation: "horizontal" })}>
          {sections.map((s, i) => (
            <button
              key={s.id}
              type="button"
              tabIndex={i === 0 ? 0 : -1}
              title={s.title}
              aria-label={s.title}
              className="h-8 min-w-8 shrink-0 rounded text-base hover:bg-bg-3"
              onClick={() => {
                setRendered(sections.length);
                requestAnimationFrame(() => grid.current?.querySelector(`[data-section="${CSS.escape(s.id)}"]`)?.scrollIntoView({ block: "start" }));
              }}
            >
              {s.icon}
            </button>
          ))}
        </nav>
      )}
      <div ref={grid} role="menu" aria-label={t("emoji_picker.emojis")} className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1" onKeyDown={onGridKey}>
        {visible.map((s) => (
          <div key={s.id} role="group" aria-label={s.title} data-section={s.id} data-testid="emoji-section">
            <p className="sticky top-0 z-10 bg-bg-1 px-1 py-1 text-[11px] font-semibold uppercase tracking-wide text-fg-2">{s.title}</p>
            <div className="grid grid-cols-8 gap-0.5">
              {s.items.map((item) => {
                const i = index++;
                return <PickerButton key={item.key} item={item} index={i} focused={i === focusIndex} onFocus={setFocus} onPick={pick} />;
              })}
            </div>
          </div>
        ))}
        {query && flat.length === 0 && <p className="p-3 text-sm text-fg-2">{t("emoji_picker.none")}</p>}
        {!data && !failed && <p className="p-3 text-xs text-fg-2">{t("common.loading")}</p>}
        {failed && <p className="p-3 text-xs text-danger">{t("emoji_picker.load_failed")}</p>}
      </div>
      {!external && (others.personal.length > 0 || others.other.length > 0) && (
        <p className="shrink-0 border-t border-line px-2 py-1 text-[11px] text-fg-2" data-testid="emoji-external-note">
          {t("emoji_picker.external_denied")}
        </p>
      )}
    </>
  );
}

/**
 * Emoji picker button with its popup. The popup is portaled to `document.body` with fixed positioning:
 * a popup inside a (virtualized, absolutely positioned) message row would be clipped by or stretch the list.
 * Its size is fixed ({@link MENU_HEIGHT}, bounded by the viewport) and reserved while the data loads, so the
 * place computed on open stays right. Escape, a click outside, scrolling or resizing close it; focus moves
 * into the grid on open and back to the button on Escape.
 */
/** `triggerClassName` sizes the opening button (the composer's toolbar wants its 40 px squares; reactions keep 32 px). */
export function EmojiPicker({ onPick, customEmojis = [], label, triggerClassName = "min-h-8 min-w-8" }: { onPick: (emoji: string) => void; customEmojis?: CustomEmoji[]; label?: string; triggerClassName?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open || !button.current || !menu.current) return;
    setPos(pickerPosition(button.current.getBoundingClientRect(), menu.current.offsetHeight, { width: window.innerWidth, height: window.innerHeight }));
  }, [open]);
  // Keyboard users land in the grid once it is placed (a hidden element cannot take the focus).
  useEffect(() => {
    if (open && pos) menu.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus({ preventScroll: true });
  }, [open, pos]);
  useDismiss(open, () => setOpen(false), { inside: [menu, button], returnFocus: button, closeOnScroll: true });
  const pick = (e: string) => {
    onPick(e);
    setOpen(false);
  };
  return (
    <span className="relative">
      <button
        ref={button}
        type="button"
        aria-label={label ?? t("messages.react")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setPos(null);
          setOpen((v) => !v);
        }}
        className={`${triggerClassName} rounded text-fg-2 hover:bg-bg-3 hover:text-fg-0`}
      >
        🙂
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            role="dialog"
            aria-label={t("messages.pick_emoji")}
            style={{ position: "fixed", top: pos?.top ?? 0, left: pos?.left ?? 0, width: `min(${MENU_WIDTH}px, calc(100vw - ${2 * MENU_GAP}px))`, height: `min(${MENU_HEIGHT}px, calc(100dvh - ${2 * MENU_GAP}px))`, visibility: pos ? "visible" : "hidden" }}
            className="z-50 flex flex-col overflow-hidden rounded-md border border-line bg-bg-1 shadow-xl"
            data-testid="emoji-picker"
          >
            <PickerPanel onPick={pick} customEmojis={customEmojis} />
          </div>,
          document.body,
        )}
    </span>
  );
}
