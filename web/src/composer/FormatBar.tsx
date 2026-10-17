// SPDX-License-Identifier: Apache-2.0
/**
 * The composer's formatting bar (docs/CLIENT.md "The composer"): a toolbar above the text box, shown and hidden with
 * the "Formatting" toggle in the input row (a device preference). One button per format the renderer supports;
 * buttons keep the focus and selection in the text box (mouse) and the toolbar uses one tab stop with the arrow keys
 * moving between its buttons (WAI-ARIA toolbar pattern). On phones the bar scrolls horizontally.
 */
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useT } from "../i18n";
import { EyeOffIcon, Svg, type IconProps } from "../components/icons";
import { FORMATS, type FormatDef, type FormatId } from "./format";

const ICONS: Record<FormatId, (p: IconProps) => ReactNode> = {
  bold: (p) => (
    <Svg {...p}>
      <path d="M7 5h6a3.5 3.5 0 0 1 0 7H7z" />
      <path d="M7 12h7a3.5 3.5 0 0 1 0 7H7z" />
    </Svg>
  ),
  italic: (p) => (
    <Svg {...p}>
      <path d="M19 4h-9M14 20H5M15 4L9 20" />
    </Svg>
  ),
  strike: (p) => (
    <Svg {...p}>
      <path d="M16 6.5A4 4 0 0 0 12 4c-2.5 0-4 1.4-4 3.2 0 1.3.8 2.2 2.3 2.8" />
      <path d="M4 12h16" />
      <path d="M8 17.5A4.5 4.5 0 0 0 12 20c2.5 0 4-1.4 4-3.2 0-.7-.2-1.3-.6-1.8" />
    </Svg>
  ),
  code: (p) => (
    <Svg {...p}>
      <path d="M16 18l6-6-6-6M8 6l-6 6 6 6" />
    </Svg>
  ),
  codeblock: (p) => (
    <Svg {...p}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M10 10l-2 2 2 2M14 10l2 2-2 2" />
    </Svg>
  ),
  quote: (p) => (
    <Svg {...p}>
      <path d="M4 5v14M9 8h11M9 12h11M9 16h7" />
    </Svg>
  ),
  bullets: (p) => (
    <Svg {...p}>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <circle cx="4.5" cy="6" r="1" />
      <circle cx="4.5" cy="12" r="1" />
      <circle cx="4.5" cy="18" r="1" />
    </Svg>
  ),
  numbers: (p) => (
    <Svg {...p}>
      <path d="M10 6h11M10 12h11M10 18h11" />
      <path d="M4 5h1v4M4 9h2" />
      <path d="M6.5 19H4c0-1.2 2.5-1.8 2.5-3a1.2 1.2 0 0 0-2.3-.4" />
    </Svg>
  ),
  link: (p) => (
    <Svg {...p}>
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
    </Svg>
  ),
  spoiler: (p) => <EyeOffIcon {...p} />,
};

/** The toggle's glyph: a large and a small "a". */
export const FormatIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 19l5-14 5 14M5 14h6" />
    <circle cx="17.5" cy="16" r="3" />
    <path d="M20.5 13v6" />
  </Svg>
);

/** The styled-input toggle's glyph: a pen with a spark. */
const StyledIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 20l4-1 10-10-3-3L5 16z" />
    <path d="M19 3v4M17 5h4" />
  </Svg>
);

/** Groups in the bar (a separator between them). */
const GROUPS: FormatId[][] = [
  ["bold", "italic", "strike", "spoiler"],
  ["code", "codeblock", "link"],
  ["quote", "bullets", "numbers"],
];

function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/** The shortcut as shown ("Ctrl+Shift+X", "Strg+B", "⌘⇧X") and as `aria-keyshortcuts`. */
export function shortcutText(def: FormatDef, t: (key: string) => string): { shown: string; aria: string } | null {
  const s = def.shortcut;
  if (!s) return null;
  const key = s.key.toUpperCase();
  const mac = isMac();
  const shown = mac ? `⌘${s.shift ? "⇧" : ""}${key}` : [t("composer.format.key_ctrl"), s.shift ? t("composer.format.key_shift") : null, key].filter(Boolean).join("+");
  const aria = [mac ? "Meta" : "Control", s.shift ? "Shift" : null, key].filter(Boolean).join("+");
  return { shown, aria };
}

export function FormatBar({ id, onFormat, styled, onStyled }: { id?: string; onFormat: (id: FormatId) => void; styled?: boolean; onStyled?: () => void }) {
  const t = useT();
  const bar = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState(0);
  const buttons = () => Array.from(bar.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = buttons();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const next = e.key === "ArrowRight" ? (at + 1) % list.length : e.key === "ArrowLeft" ? (at - 1 + list.length) % list.length : e.key === "Home" ? 0 : e.key === "End" ? list.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    setCurrent(next);
    list[next]!.focus();
  };
  let index = -1;
  const button = (key: string, label: string, title: string, icon: ReactNode, onClick: () => void, extra: { pressed?: boolean; keys?: string; testId: string }) => {
    index++;
    const mine = index;
    return (
      <button
        key={key}
        type="button"
        aria-label={label}
        title={title}
        aria-pressed={extra.pressed}
        aria-keyshortcuts={extra.keys}
        tabIndex={mine === current ? 0 : -1}
        // The text box keeps the focus and its selection.
        onMouseDown={(e) => e.preventDefault()}
        onFocus={() => setCurrent(mine)}
        onClick={onClick}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-fg-1 hover:bg-bg-3 hover:text-fg-0 aria-pressed:bg-accent-soft aria-pressed:text-accent md:h-8 md:w-9"
        data-testid={extra.testId}
      >
        {icon}
      </button>
    );
  };
  return (
    <div ref={bar} id={id} role="toolbar" aria-label={t("composer.format.bar")} onKeyDown={onKeyDown} className="mb-1 flex items-center gap-0.5 overflow-x-auto rounded-lg border border-line bg-bg-1 px-1 py-0.5" data-testid="format-bar">
      {GROUPS.map((group, g) => (
        <span key={g} className="flex shrink-0 items-center gap-0.5">
          {g > 0 && <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-line" />}
          {group.map((id) => {
            const def = FORMATS.find((f) => f.id === id)!;
            const label = t(`composer.format.${id}`);
            const keys = shortcutText(def, t);
            return button(id, label, keys ? t("composer.format.with_shortcut", { label, keys: keys.shown }) : label, ICONS[id]({ size: 18 }), () => onFormat(id), { keys: keys?.aria, testId: `format-${id}` });
          })}
        </span>
      ))}
      {onStyled && (
        <span className="ml-auto flex shrink-0 items-center gap-0.5 pl-1">
          <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-line" />
          {button("styled", t("composer.format.styled"), t("composer.format.styled_hint"), <StyledIcon size={18} />, onStyled, { pressed: !!styled, testId: "format-styled" })}
        </span>
      )}
    </div>
  );
}
