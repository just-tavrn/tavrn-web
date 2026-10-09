// SPDX-License-Identifier: Apache-2.0
/**
 * The notification center (design note 4.11): a bell with the number of unseen entries; its panel lists the
 * recent mentions, DMs and calls with a jump to the conversation. Opening the panel marks them seen.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";
import { intlLocale, useT } from "../i18n";
import { useNotifications } from "../stores/notifications";
import { rectOf, useFloating, type AnchorRect } from "../lib/position";
import { useShell } from "./AppShell";
import { formatFullTime } from "../lib/format";
import { BellIcon } from "./icons";

const ICON = { mention: "@", dm: "✉", message: "#", call: "📞", legal: "§", report: "⚑" } as const;

function NotificationPanel({ anchor, onClose }: { anchor: AnchorRect; onClose: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const { closeNav } = useShell();
  const entries = useNotifications((s) => s.entries);
  const ref = useRef<HTMLDivElement>(null);
  const style = useFloating(ref, anchor, { prefer: "bottom", gap: 6 }, [entries.length]);
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest?.("[data-notification-bell]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", onKey);
    ref.current?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const time = new Intl.DateTimeFormat(intlLocale(), { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
  return createPortal(
    <div ref={ref} role="dialog" aria-label={t("notify.center")} tabIndex={-1} className="z-[65] flex w-80 flex-col overflow-hidden rounded-lg border border-line bg-bg-1 shadow-xl outline-none" style={style} data-testid="notification-panel">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <h2 className="flex-1 text-sm font-semibold">{t("notify.center")}</h2>
        {entries.length > 0 && (
          <button type="button" className="min-h-8 rounded px-2 text-xs text-fg-2 hover:bg-bg-3 hover:text-fg-0" onClick={() => useNotifications.getState().clear()}>
            {t("notify.clear")}
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {entries.length === 0 && <p className="p-4 text-sm text-fg-2">{t("notify.empty")}</p>}
        <ul>
          {entries.map((e) => (
            <li key={e.id} className="border-b border-line/50 last:border-0">
              <button
                type="button"
                className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-bg-3/60 focus:bg-bg-3/60 focus:outline-none"
                data-testid="notification-entry"
                data-kind={e.kind}
                onClick={() => {
                  onClose();
                  closeNav();
                  if (e.path) navigate(e.path);
                }}
              >
                <span aria-hidden="true" className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs text-accent">
                  {ICON[e.kind]}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-fg-0">{e.title}</span>
                  <span className="line-clamp-2 block text-xs text-fg-1">{e.body}</span>
                  <time className="block text-[10px] text-fg-2" dateTime={e.at} title={formatFullTime(e.at)}>
                    {time.format(new Date(e.at))}
                  </time>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>,
    document.body,
  );
}

/** The bell with the unseen count; `className` sets its display (the account bar hides it on phones). */
export function NotificationBell({ className = "inline-flex" }: { className?: string }) {
  const t = useT();
  const unseen = useNotifications((s) => s.entries.filter((e) => !e.read).length);
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);
  return (
    <>
      <button
        type="button"
        data-notification-bell
        data-testid="notification-bell"
        aria-label={unseen ? t("notify.bell_unseen", { count: unseen }) : t("notify.bell")}
        title={t("notify.bell")}
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        className={`relative min-h-10 min-w-10 items-center justify-center rounded-md text-fg-2 hover:bg-bg-3 hover:text-fg-0 ${className}`}
        onClick={(e) => {
          if (anchor) return setAnchor(null);
          setAnchor(rectOf(e.currentTarget));
          useNotifications.getState().markAllRead();
        }}
      >
        <BellIcon size={22} />
        {unseen > 0 && (
          <span className="absolute right-0.5 top-0.5 min-w-4 rounded-full bg-danger-solid px-1 text-center text-[10px] font-semibold leading-4 text-white" data-testid="notification-count">
            {unseen > 99 ? "99+" : unseen}
          </span>
        )}
      </button>
      {anchor && <NotificationPanel anchor={anchor} onClose={() => setAnchor(null)} />}
    </>
  );
}
