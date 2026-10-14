// SPDX-License-Identifier: Apache-2.0
/**
 * The session timer and the status line of a voice channel (VOICE.md §5 `session_started_at`, §2a `status`;
 * docs/CLIENT.md "Voice channels"). The timer counts from the node's session start (right for late joiners and for
 * people outside the call) and is hidden while the channel is empty; its live region speaks the running time at most
 * once a minute. The status line sits under the channel's name; members with `voice_status` edit it in place (Enter
 * saves, Escape cancels, a counter for the 128 characters), everybody else reads it.
 */
import { useEffect, useId, useRef, useState } from "react";
import type { Channel } from "@tavrn/sdk";
import { useT } from "../../i18n";
import { useNode } from "../../components/NodeScope";
import { toastError } from "../../stores/toasts";
import { PencilIcon } from "./icons";

/** The length limit of a voice channel's status (VOICE.md §2a). */
export const STATUS_MAX = 128;

/** `hh:mm:ss` of a duration (hours keep growing past a day: `27:00:01`). Negative or odd values read as zero. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Milliseconds since `startedAt` (RFC 3339) at `now`, zero for an unreadable start. */
export function elapsedSince(startedAt: string, now = Date.now()): number {
  const t = Date.parse(startedAt);
  return Number.isFinite(t) ? Math.max(0, now - t) : 0;
}

/** The current time, refreshed every `every` milliseconds while `every` is positive (0 = never). */
export function useNow(every: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (every <= 0) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), every);
    return () => window.clearInterval(id);
  }, [every]);
  return now;
}

/**
 * `hh:mm:ss` since the session started, ticking every second; nothing while `startedAt` is null. The visible digits
 * are aria-hidden; a polite live region announces the running time once a minute (not once a second).
 */
export function SessionTimer({ startedAt, className = "" }: { startedAt: string | null; className?: string }) {
  const t = useT();
  const now = useNow(startedAt ? 1000 : 0);
  if (!startedAt) return null;
  const elapsed = elapsedSince(startedAt, now);
  const text = formatElapsed(elapsed);
  const minutes = formatElapsed(elapsed - (elapsed % 60_000)).slice(0, 5);
  return (
    <span className={`inline-flex items-center gap-1 text-xs tabular-nums text-fg-2 ${className}`} data-testid="voice-session-timer" title={t("voice.session.timer_label", { time: text })}>
      <span aria-hidden="true">{text}</span>
      {/* Once a minute: the same text while the minute lasts, so the live region stays quiet in between. */}
      <span className="sr-only" aria-live="polite" data-testid="voice-session-announce">
        {t("voice.session.announce", { time: minutes })}
      </span>
    </span>
  );
}

/**
 * The status line under the channel's name. `canEdit` (the `voice_status` bit) turns it into an in-place editor:
 * click the text or the pencil, type, Enter saves through the channel update route, Escape (or leaving the field)
 * cancels. Without a status and without the bit nothing is rendered.
 */
export function VoiceStatusLine({ roomId, channel, canEdit }: { roomId: string; channel: Pick<Channel, "id" | "status">; canEdit: boolean }) {
  const t = useT();
  const { api } = useNode();
  const status = channel.status ?? "";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(status);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const hintId = useId();
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);
  const start = () => {
    if (!canEdit) return;
    setDraft(status);
    setEditing(true);
  };
  const save = async () => {
    const next = draft.trim();
    if (next === status) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await api.channels.update(roomId, channel.id, { status: next });
      setEditing(false);
    } catch (e) {
      toastError(e);
    } finally {
      setSaving(false);
    }
  };
  if (editing) {
    return (
      <div className="flex min-w-0 items-center gap-2" data-testid="voice-status-editor">
        <input
          ref={inputRef}
          value={draft}
          maxLength={STATUS_MAX}
          disabled={saving}
          aria-label={t("voice.channel_status.label")}
          aria-describedby={hintId}
          placeholder={t("voice.channel_status.placeholder")}
          className="min-h-8 min-w-0 flex-1 rounded-md border border-line-strong bg-bg-0 px-2 text-xs text-fg-0 outline-none placeholder:text-fg-2 focus:border-accent"
          data-testid="voice-status-input"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void save();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
            }
          }}
          onBlur={() => {
            if (!saving) setEditing(false);
          }}
        />
        <span id={hintId} className="shrink-0 text-[11px] tabular-nums text-fg-2" data-testid="voice-status-counter">
          <span aria-hidden="true">
            {draft.length}/{STATUS_MAX}
          </span>
          <span className="sr-only">
            {t("voice.channel_status.remaining", { count: draft.length, max: STATUS_MAX })}. {t("voice.channel_status.hint")}
          </span>
        </span>
      </div>
    );
  }
  if (!status && !canEdit) return null;
  return (
    <div className="flex min-w-0 items-center gap-1">
      {status ? (
        <p className="truncate text-xs text-fg-2" data-testid="voice-status" title={status}>
          {status}
        </p>
      ) : (
        <p className="truncate text-xs italic text-fg-2" data-testid="voice-status-empty">
          {t("voice.channel_status.empty")}
        </p>
      )}
      {canEdit && (
        <button
          type="button"
          onClick={start}
          aria-label={t("voice.channel_status.edit")}
          title={t("voice.channel_status.edit")}
          className="inline-flex min-h-6 min-w-6 shrink-0 items-center justify-center rounded text-fg-2 hover:bg-bg-3 hover:text-fg-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          data-testid="voice-status-edit"
        >
          <PencilIcon size={12} />
        </button>
      )}
    </div>
  );
}
