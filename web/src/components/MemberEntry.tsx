// SPDX-License-Identifier: Apache-2.0
import type { User } from "@tavrn/sdk";
import { usePresence, statusLine, activeCustom } from "../stores/presence";
import { ActivityLine } from "../activity/ActivityView";
import { UserAvatar } from "./Avatar";
import { ProfileTrigger, useActivityLabel } from "./ProfilePopover";
import type { AnchorRect } from "../lib/position";

/**
 * The member list's text next to the channel list's (`sidebarRow.ts`, docs/CLIENT.md "UI conventions"): the name like a
 * channel name (16 px medium on a 20 px line), the status line 12 px on a 16 px line, so both fit the 40 px row.
 */
export const MEMBER_NAME = "text-base font-medium leading-5";
export const MEMBER_STATUS = "text-xs leading-4 text-fg-2";

/**
 * A member of a room in the member list (design note 4.9): avatar with presence dot, name (in the color of
 * the highest colored role) and the status line (custom status or activity, with "via <application>"
 * for activities a program set through the local bridge); a click opens the profile card (`onOpenProfile`: the
 * list shows it, see {@link ProfileTrigger}).
 */
export function MemberEntry({ user, name, color, onOpenProfile }: { user: User; name: string; color?: string | null; onOpenProfile?: (user: User, anchor: AnchorRect) => void }) {
  const presence = usePresence((s) => s.users[user.address]);
  const label = useActivityLabel();
  const line = statusLine(presence, label);
  // The activity (not a custom status) fills the line: show "via <application>" as well (APPLICATIONS.md §7.2).
  const activity = !activeCustom(presence?.custom_status) ? presence?.activity : null;
  return (
    <ProfileTrigger user={user} className="flex min-w-0 flex-1 items-center gap-2 rounded-md" onOpen={onOpenProfile && ((anchor) => onOpenProfile(user, anchor))}>
      <UserAvatar user={user} size={28} presence />
      <span className="min-w-0">
        <span className={`block truncate ${MEMBER_NAME}`} style={color ? { color } : undefined} data-testid="member-name">
          {name}
        </span>
        {line && (
          <span className={`emoji-font block truncate ${MEMBER_STATUS}`} data-testid="member-status-line">
            {activity ? <ActivityLine activity={activity} label={line} /> : line}
          </span>
        )}
      </span>
    </ProfileTrigger>
  );
}
