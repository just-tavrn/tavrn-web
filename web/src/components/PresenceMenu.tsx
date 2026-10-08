// SPDX-License-Identifier: Apache-2.0
/**
 * The own presence on the account bar (design note 4.9): avatar with the status dot, a menu to pick
 * online / idle / do not disturb / invisible, a custom status (text, emoji, expiry) and an activity; node admins also
 * reach the node administration here.
 * Mounting it keeps the presence in sync on every node with a session and runs the idle detection.
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { Activity } from "@tavrn/sdk";
import { useT } from "../i18n";
import { useAuth } from "../stores/auth";
import { useNodes } from "../stores/nodes";
import { CHOSEN_STATUSES, DOT_CLASS, activeCustom, usePresence, type PresenceStatus } from "../stores/presence";
import { toastError } from "../stores/toasts";
import { signOut } from "../stores/e2ee";
import { createIdleDetector, idleTimeoutMs, useIdleSettings } from "../lib/idle";
import { pushActivity, pushPresence, setAutoIdle, syncPresence } from "../lib/presence";
import { useRealtimeState } from "../hooks/useRealtime";
import { UserAvatar } from "./Avatar";
import { useShell } from "./AppShell";
import { Button, Dialog, Field, Input } from "./ui";
import { rovingKeyDown } from "../lib/a11y";
import { WrenchIcon } from "./icons";

/** Expiry choices of a custom status, in minutes (0 = never; "today" = until midnight). */
const EXPIRY = ["never", "30m", "1h", "4h", "today"] as const;
const ACTIVITY_TYPES = ["playing", "listening", "watching", "streaming", "competing"] as const;

export function expiryTime(choice: (typeof EXPIRY)[number], now = new Date()): string | null {
  const minutes = { never: 0, "30m": 30, "1h": 60, "4h": 240, today: 0 }[choice];
  if (choice === "today") {
    const end = new Date(now);
    end.setHours(23, 59, 0, 0);
    return end.getTime() > now.getTime() + 60_000 ? end.toISOString() : null;
  }
  return minutes ? new Date(now.getTime() + minutes * 60_000).toISOString() : null;
}

/** Sync on start, on new node sessions and on reconnect; automatic idle after the set timeout (default 10 minutes). */
function usePresenceSync() {
  const token = useAuth((s) => s.token);
  const idleMinutes = useIdleSettings((s) => s.minutes);
  const domains = useNodes((s) => Object.keys(s.sessions).sort().join(","));
  const status = useRealtimeState((s) => s.status);
  useEffect(() => {
    if (!token || status !== "ready") return;
    void syncPresence().catch(() => undefined);
  }, [token, domains, status]);
  useEffect(() => {
    if (!token) return;
    const timeoutMs = idleTimeoutMs(idleMinutes);
    // "Never": an automatic idle of the earlier setting ends right away.
    if (timeoutMs === null) {
      void setAutoIdle(false);
      return;
    }
    const detector = createIdleDetector({ timeoutMs, onIdle: () => void setAutoIdle(true), onActive: () => void setAutoIdle(false) });
    return () => detector.stop();
  }, [token, idleMinutes]);
}

export function PresenceMenu() {
  const t = useT();
  usePresenceSync();
  const user = useAuth((s) => s.user);
  const remoteHome = useAuth((s) => !!s.home);
  const mine = usePresence((s) => s.mine);
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<"custom" | "activity" | "logout" | null>(null);
  const navigate = useNavigate();
  const { closeNav } = useShell();
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const effective = (mine?.effective ?? "online") as PresenceStatus;
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    // Escape closes the menu and gives the focus back to its button (WAI-ARIA menu button).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    // The first entry takes the focus; arrow keys move between the entries.
    ref.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
    document.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  if (!user) return null;
  const choose = async (status: (typeof CHOSEN_STATUSES)[number]) => {
    setOpen(false);
    usePresence.getState().setAutoIdle(false);
    try {
      await pushPresence({ status });
    } catch (e) {
      toastError(e);
    }
  };
  const custom = activeCustom(mine?.custom_status);
  return (
    <div ref={ref} className="relative">
      <button ref={trigger} type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} aria-label={t("presence.menu")} title={t("presence.menu")} className="flex min-h-10 min-w-10 items-center justify-center rounded-md hover:bg-bg-3" data-testid="presence-menu-button" data-status={effective}>
        <UserAvatar user={user} size={32} presence />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={t("presence.menu")}
          className="absolute bottom-full left-0 z-40 mb-2 w-64 rounded-lg border border-line bg-bg-1 p-1 shadow-xl"
          data-testid="presence-menu"
          onKeyDown={(e) => {
            if (e.key === "Tab") setOpen(false);
            else rovingKeyDown(e, '[role^="menuitem"]', { orientation: "vertical" });
          }}
        >
          {CHOSEN_STATUSES.map((s) => (
            <button key={s} type="button" role="menuitemradio" tabIndex={-1} aria-checked={(mine?.status ?? "online") === s || (s === "idle" && effective === "idle")} onClick={() => void choose(s)} className="flex min-h-10 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-bg-3" data-testid={`presence-${s}`}>
              <span className={`h-2.5 w-2.5 rounded-full ${DOT_CLASS[s]}`} aria-hidden="true" />
              <span className="flex-1">{t(`presence.${s}`)}</span>
            </button>
          ))}
          <div role="separator" className="my-1 h-px bg-line" />
          <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setOpen(false); setDialog("custom"); }} className="flex min-h-10 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-bg-3" data-testid="presence-custom">
            <span aria-hidden="true">💬</span>
            <span className="min-w-0 flex-1 truncate">{custom ? [custom.emoji, custom.text].filter(Boolean).join(" ") : t("presence.custom")}</span>
          </button>
          <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setOpen(false); setDialog("activity"); }} className="flex min-h-10 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-bg-3" data-testid="presence-activity">
            <span aria-hidden="true">🎮</span>
            <span className="min-w-0 flex-1 truncate">{mine?.activity ? t(`presence.type.${mine.activity.type}`, { name: mine.activity.name }) : t("presence.activity")}</span>
          </button>
          {/* Node administration: node admins of the home node only (an account of another node administers nothing here). */}
          {user.is_node_admin && !remoteHome && (
            <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setOpen(false); closeNav(); navigate("/admin"); }} className="flex min-h-10 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-bg-3" data-testid="presence-admin">
              <WrenchIcon size={16} />
              <span className="min-w-0 flex-1 truncate">{t("admin.link")}</span>
            </button>
          )}
          {/* Legal pages, terms and the own data (design note 4.14). */}
          <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setOpen(false); closeNav(); navigate("/settings/legal"); }} className="flex min-h-10 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-bg-3" data-testid="presence-legal">
            <span aria-hidden="true">§</span>
            <span className="min-w-0 flex-1 truncate">{t("legal.menu")}</span>
          </button>
          {/* Logout lives here, at the very bottom, behind a confirmation (design note 4.11). */}
          <div role="separator" className="my-1 h-px bg-line" />
          <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setOpen(false); setDialog("logout"); }} className="flex min-h-10 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-danger hover:bg-danger/10" data-testid="presence-logout">
            <span aria-hidden="true">⎋</span>
            <span className="min-w-0 flex-1 truncate">{t("auth.logout")}</span>
          </button>
        </div>
      )}
      <LogoutDialog open={dialog === "logout"} onClose={() => setDialog(null)} />
      <CustomStatusDialog open={dialog === "custom"} onClose={() => setDialog(null)} />
      <ActivityDialog open={dialog === "activity"} onClose={() => setDialog(null)} />
    </div>
  );
}

function LogoutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title={t("menu.logout_title")} open={open} onClose={onClose}>
      <div className="space-y-4 text-sm text-fg-1" data-testid="logout-dialog">
        <p>{t("menu.logout_text")}</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await signOut();
              } catch (e) {
                toastError(e);
                setBusy(false);
              }
            }}
          >
            {t("auth.logout")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function CustomStatusDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const current = activeCustom(usePresence((s) => s.mine?.custom_status));
  const [text, setText] = useState("");
  const [emoji, setEmoji] = useState("");
  const [expiry, setExpiry] = useState<(typeof EXPIRY)[number]>("never");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setText(current?.text ?? "");
    setEmoji(current?.emoji ?? "");
    setExpiry("never");
    // Only when the dialog opens.
  }, [open]);
  const save = async (clear: boolean) => {
    setBusy(true);
    try {
      await pushPresence({ custom_status: clear ? null : { text: text.trim(), emoji: emoji.trim() || null, expires_at: expiryTime(expiry) } });
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={t("presence.custom_title")} open={open} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save(false);
        }}
      >
        <div className="flex gap-2">
          <div className="w-20">
            <Field label={t("presence.custom_emoji")}>
              <Input name="custom_emoji" value={emoji} onChange={(e) => setEmoji(e.target.value)} maxLength={32} placeholder="🎮" />
            </Field>
          </div>
          <div className="flex-1">
            <Field label={t("presence.custom_text")}>
              <Input name="custom_text" value={text} onChange={(e) => setText(e.target.value)} maxLength={128} autoFocus />
            </Field>
          </div>
        </div>
        <Field label={t("presence.custom_expires")}>
          <select name="custom_expires" value={expiry} onChange={(e) => setExpiry(e.target.value as (typeof EXPIRY)[number])} className="min-h-10 w-full rounded-md border border-line bg-bg-0 px-3 text-sm">
            {EXPIRY.map((x) => (
              <option key={x} value={x}>
                {t(`presence.expires.${x}`)}
              </option>
            ))}
          </select>
        </Field>
        <div className="flex flex-wrap justify-end gap-2">
          {current && (
            <Button variant="ghost" disabled={busy} onClick={() => void save(true)}>
              {t("presence.custom_clear")}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={busy || (!text.trim() && !emoji.trim())}>
            {t("common.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ActivityDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const current = usePresence((s) => s.mine?.activity ?? null);
  const [type, setType] = useState<Activity["type"]>("playing");
  const [name, setName] = useState("");
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setType(current?.type ?? "playing");
    setName(current?.name ?? "");
    setDetails(current?.details ?? "");
  }, [open]);
  const save = async (clear: boolean) => {
    setBusy(true);
    try {
      await pushActivity(clear ? null : { type, name: name.trim(), details: details.trim() || null });
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={t("presence.activity_title")} open={open} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save(false);
        }}
      >
        <Field label={t("presence.activity_type")}>
          <select name="activity_type" value={type} onChange={(e) => setType(e.target.value)} className="min-h-10 w-full rounded-md border border-line bg-bg-0 px-3 text-sm">
            {ACTIVITY_TYPES.map((x) => (
              <option key={x} value={x}>
                {t(`presence.type_label.${x}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("presence.activity_name")}>
          <Input name="activity_name" value={name} onChange={(e) => setName(e.target.value)} maxLength={128} autoFocus />
        </Field>
        <Field label={t("presence.activity_details")}>
          <Input name="activity_details" value={details} onChange={(e) => setDetails(e.target.value)} maxLength={128} />
        </Field>
        <div className="flex flex-wrap justify-end gap-2">
          {current && (
            <Button variant="ghost" disabled={busy} onClick={() => void save(true)}>
              {t("presence.activity_clear")}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={busy || !name.trim()}>
            {t("common.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
