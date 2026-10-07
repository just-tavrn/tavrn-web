// SPDX-License-Identifier: Apache-2.0
/**
 * Rich activities in the member list and the profile card (APPLICATIONS.md §7.2): the type and title as
 * before, plus `details`, `state`, the end time and "via <application name>" with the bot's avatar when
 * a room member already loaded in this scope is the application's bot. Nothing else (no images from the
 * program, no buttons).
 */
import { useQueryClient } from "@tanstack/react-query";
import type { Activity, Member, User } from "@tavrn/sdk";
import { intlLocale, useT } from "../i18n";
import { UserAvatar } from "../components/Avatar";
import { activityEnd, botOfApplication, formatEnd } from "./display";

/** The bot user of `ref` among the room members this client loaded (null when unknown). */
export function useKnownBot(ref: string | null | undefined): User | null {
  const queryClient = useQueryClient();
  if (!ref) return null;
  const users: User[] = [];
  for (const [, data] of queryClient.getQueriesData<Member[]>({ queryKey: ["members"] })) {
    if (Array.isArray(data)) for (const m of data) if (m?.user) users.push(m.user);
  }
  return botOfApplication(ref, users);
}

/** "via <name>", with the bot's avatar when known. */
export function ActivityVia({ activity, size = 14 }: { activity: Activity; size?: number }) {
  const t = useT();
  const app = activity.application;
  const bot = useKnownBot(app?.ref);
  if (!app) return null;
  return (
    <span className="inline-flex min-w-0 items-center gap-1 align-middle" data-testid="activity-via" data-ref={app.ref}>
      {bot && <UserAvatar user={bot} size={size} testId="activity-bot-avatar" />}
      <span className="truncate">{t("activity.via", { name: app.name })}</span>
    </span>
  );
}

/**
 * The compact line of the member list: "Playing Space Miners · via Space Miners", truncated; the full
 * text (details, state, end) as the tooltip.
 */
export function ActivityLine({ activity, label }: { activity: Activity; label: string }) {
  const t = useT();
  const end = activityEnd(activity);
  const title = [label, activity.details, activity.state, end ? t("activity.until", { time: formatEnd(end, intlLocale()) }) : null, activity.application ? t("activity.via", { name: activity.application.name }) : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <span className="flex min-w-0 items-center gap-1" title={title}>
      <span className="truncate">{label}</span>
      {activity.application && (
        <>
          <span aria-hidden="true">·</span>
          <ActivityVia activity={activity} size={12} />
        </>
      )}
    </span>
  );
}

/** The activity block of the profile card (only when there is more than the status line shows). */
export function ActivityDetails({ activity, label, showLabel }: { activity: Activity; label: string; showLabel: boolean }) {
  const t = useT();
  const end = activityEnd(activity);
  if (!showLabel && !activity.details && !activity.state && !end && !activity.application) return null;
  return (
    <div className="mt-2 min-w-0 rounded-md bg-bg-2 px-2 py-1.5 text-xs text-fg-1" data-testid="profile-activity">
      {showLabel && <p className="truncate font-medium">{label}</p>}
      {activity.details && (
        <p className="truncate" data-testid="activity-details">
          {activity.details}
        </p>
      )}
      {activity.state && (
        <p className="truncate" data-testid="activity-state">
          {activity.state}
        </p>
      )}
      {end && (
        <p className="truncate text-fg-2" data-testid="activity-ends">
          {t("activity.until", { time: formatEnd(end, intlLocale()) })}
        </p>
      )}
      {activity.application && (
        <p className="flex min-w-0 text-fg-2">
          <ActivityVia activity={activity} size={16} />
        </p>
      )}
    </div>
  );
}
