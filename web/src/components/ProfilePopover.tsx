// SPDX-License-Identifier: Apache-2.0
/**
 * Profiles in the client (design note 4.9): {@link ProfileTrigger} opens a {@link ProfileCard} on a click on a
 * name or avatar (member list, DMs, friends, messages), the full page (`/u/<address>`) shows the same
 * {@link ProfileView}. A profile is always loaded from the node that served the user object (its own
 * copy, with its own image paths), so clients never load images from other nodes.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";
import { TavrnApiError, isBotKind, type Activity, type Profile, type User } from "@tavrn/sdk";
import { useT } from "../i18n";
import { renderMarkdown } from "../lib/markdown";
import { hueFor } from "../lib/format";
import { useFloating, type AnchorRect } from "../lib/position";
import { useAuth } from "../stores/auth";
import { apiFor } from "../stores/nodes";
import { usePresence, statusLine, useStatus, activeCustom } from "../stores/presence";
import { ActivityDetails } from "../activity/ActivityView";
import { describeError } from "../stores/toasts";
import { BotBadge } from "./Badges";
import { UserAvatar, useHoverActive } from "./Avatar";
import { FriendRequestForm } from "./FriendRequestForm";
import { useNode } from "./NodeScope";
import { Button, ErrorText } from "./ui";
import { openDm, useFriends } from "../pages/DirectMessages";
import { useFocusTrap } from "../lib/focusTrap";

/** Error codes of `POST /conversations` that the "friends only" notice explains (design note 4.9). */
export const DM_REFUSED = ["dm.friends_only", "dm.not_friends", "dm.no_shared_room"];

export function useActivityLabel() {
  const t = useT();
  return (a: Activity) => t(`presence.type.${a.type}`, { name: a.name });
}

/** The profile of `address` as `node` serves it (null: the current scope). */
export function useProfile(address: string, node?: string | null) {
  const scoped = useNode();
  const client = node === undefined ? scoped.api : apiFor(node);
  const domain = node === undefined ? scoped.domain : (node ?? "");
  return useQuery({ queryKey: ["profile", domain, address], queryFn: () => client.users.profile(address), staleTime: 30_000, retry: false });
}

/** Explains a refused DM and offers a friend request (with a message) right there. */
export function DmRefusedNotice({ error, address, name }: { error: unknown; address: string; name: string }) {
  const t = useT();
  const code = error instanceof TavrnApiError ? error.code : undefined;
  if (!code || !DM_REFUSED.includes(code)) return <ErrorText>{describeError(error)}</ErrorText>;
  return (
    <div role="alert" className="space-y-2 rounded-md border border-warn/40 bg-warn/10 p-3 text-sm" data-testid="dm-refused" data-code={code}>
      <p>{t(code === "dm.no_shared_room" ? "requests.no_shared_room" : "requests.friends_only", { name })}</p>
      <FriendRequestForm user={address} compact />
    </div>
  );
}

function HeaderImage({ profile, node, height }: { profile: Profile; node?: string | null; height: number }) {
  const scoped = useNode();
  const client = node === undefined ? scoped.api : apiFor(node);
  const still = client.mediaUrl(profile.header_still);
  const full = client.mediaUrl(profile.header);
  const animated = full && full !== still ? full : null;
  const { ref, active } = useHoverActive<HTMLDivElement>(!!animated);
  const src = animated && active ? animated : still;
  return (
    <div ref={ref} className="w-full overflow-hidden rounded-t-xl" style={{ height, background: `linear-gradient(135deg, hsl(${hueFor(profile.address)} 40% 30%), hsl(${(hueFor(profile.address) + 60) % 360} 35% 22%))` }} data-testid="profile-header" data-animated={src === animated ? "true" : "false"}>
      {src && <img src={src} alt="" className="h-full w-full object-cover" />}
    </div>
  );
}

/** Profile content: header, avatar, names, presence, bio, linked accounts and actions. */
export function ProfileView({ profile, node, onDone, large = false }: { profile: Profile; node?: string | null; onDone?: () => void; large?: boolean }) {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const me = useAuth((s) => s.user);
  const friends = useFriends();
  const status = useStatus(profile.address, me?.address);
  const presence = usePresence((s) => (profile.address === me?.address ? s.mine : s.users[profile.address]));
  const activityLabel = useActivityLabel();
  const line = statusLine(presence, activityLabel);
  const bio = useMemo(() => (profile.bio ? renderMarkdown(profile.bio) : ""), [profile.bio]);
  const [dmError, setDmError] = useState<unknown>(null);
  const [adding, setAdding] = useState(false);
  const self = profile.address === me?.address;
  const friend = friends.data?.friends.some((f) => f.user.address === profile.address);
  const pending = friends.data?.outgoing.some((r) => r.user.address === profile.address);
  const size = large ? 96 : 72;
  const message = async () => {
    setDmError(null);
    try {
      navigate(await openDm(profile.address, queryClient));
      onDone?.();
    } catch (e) {
      setDmError(e);
    }
  };
  return (
    <div data-testid="profile-view" data-address={profile.address}>
      <HeaderImage profile={profile} node={node} height={large ? 180 : 96} />
      <div className="px-4 pb-4">
        <div className="-mt-9 flex items-end justify-between gap-2">
          <span className="rounded-full border-4 border-bg-1 bg-bg-1">
            <UserAvatar user={profile} node={node} size={size} presence testId="profile-avatar" />
          </span>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <h2 className={`truncate font-semibold ${large ? "text-xl" : "text-base"}`} data-testid="profile-name">
            {profile.display_name}
          </h2>
          {isBotKind(profile.kind) && <BotBadge kind={profile.kind} />}
        </div>
        {/* The full address, always (design note 9d). */}
        <p className="truncate text-xs text-fg-2" data-testid="profile-address">
          {profile.address}
        </p>
        <p className="mt-1 text-xs text-fg-1" data-testid="profile-status" data-status={status}>
          {t(`presence.${status}`)}
          {line ? ` · ${line}` : ""}
        </p>
        {presence?.activity && <ActivityDetails activity={presence.activity} label={activityLabel(presence.activity)} showLabel={!!activeCustom(presence.custom_status)} />}
        {bio && <div className="markdown mt-3 border-t border-line pt-3 text-sm text-fg-1" data-testid="profile-bio" dangerouslySetInnerHTML={{ __html: bio }} />}
        {profile.links.length > 0 && (
          <ul className="mt-3 space-y-1 border-t border-line pt-3 text-sm" data-testid="profile-links">
            {profile.links.map((l, i) => (
              <li key={`${l.service}-${i}`} className="flex min-w-0 items-center gap-2" data-service={l.service}>
                <span className="w-20 shrink-0 text-xs text-fg-2">{t(`profile.service.${l.service}`)}</span>
                {l.url ? (
                  <a href={l.url} target="_blank" rel="noopener noreferrer nofollow ugc" className="min-w-0 truncate text-accent hover:underline">
                    {l.value}
                  </a>
                ) : (
                  <span className="min-w-0 truncate">{l.value}</span>
                )}
                <span className="ml-auto shrink-0 text-[10px] text-fg-2" title={t("profile.not_verified_hint")}>
                  {t("profile.not_verified")}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          {self ? (
            <Button
              variant="ghost"
              onClick={() => {
                onDone?.();
                navigate("/settings/profile");
              }}
            >
              {t("profile.edit")}
            </Button>
          ) : (
            <>
              <Button onClick={() => void message()} data-testid="profile-message">
                {t("profile.message")}
              </Button>
              {!friend && !pending && (
                <Button variant="ghost" onClick={() => setAdding((a) => !a)} data-testid="profile-add-friend">
                  {t("profile.add_friend")}
                </Button>
              )}
            </>
          )}
          {!large && (
            <Link to={`/u/${encodeURIComponent(profile.address)}${node ? `?via=${encodeURIComponent(node)}` : ""}`} onClick={onDone} className="inline-flex min-h-10 items-center px-2 text-sm text-accent hover:underline" data-testid="profile-full">
              {t("profile.view")}
            </Link>
          )}
        </div>
        {adding && (
          <div className="mt-3">
            <FriendRequestForm user={profile.address} compact onSent={() => setAdding(false)} />
          </div>
        )}
        {!!dmError && (
          <div className="mt-3">
            <DmRefusedNotice error={dmError} address={profile.address} name={profile.display_name} />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A floating card next to the trigger (a bottom sheet on phones). Rendered into `document.body` (the
 * member list drawer is transformed, which made a `fixed` card inside it relative to the drawer and cut
 * it off), placed with collision handling and scrolling inside when taller than the viewport.
 */
export function ProfileCard({ address, node, anchor, onClose }: { address: string; node?: string | null; anchor: AnchorRect | null; onClose: () => void }) {
  const t = useT();
  const profile = useProfile(address, node);
  const ref = useRef<HTMLDivElement>(null);
  const narrow = typeof window !== "undefined" && window.innerWidth < 640;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Modal card: the card takes the focus, Tab stays inside, the trigger gets the focus back.
  useFocusTrap(ref, true, { initial: () => ref.current });
  const floating = useFloating(ref, narrow ? null : anchor, { prefer: "right" }, [profile.status]);
  const style: CSSProperties = narrow || !anchor ? {} : { ...floating, width: 320 };
  const centered = !narrow && !anchor;
  return createPortal(
    <div className={`fixed inset-0 z-50 ${centered ? "flex items-center justify-center p-4" : ""}`} onMouseDown={onClose} data-testid="profile-popover-backdrop">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={t("profile.title")}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        className={narrow ? "fixed inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto rounded-t-xl border border-line bg-bg-1 shadow-xl outline-none" : `overflow-y-auto rounded-xl border border-line bg-bg-1 shadow-xl outline-none ${centered ? "max-h-[90dvh] w-80" : ""}`}
        style={style}
        data-testid="profile-popover"
      >
        {profile.isPending && <p className="p-4 text-sm text-fg-2">{t("common.loading")}</p>}
        {profile.isError && <p className="p-4 text-sm text-danger">{describeError(profile.error)}</p>}
        {profile.data && <ProfileView profile={profile.data} node={node} onDone={onClose} />}
      </div>
    </div>,
    document.body,
  );
}

/**
 * A name or avatar that opens the profile card. `node` = the node that served `user` (default: the
 * current scope).
 */
export function ProfileTrigger({ user, node, children, className = "", testId }: { user: Pick<User, "address" | "display_name">; node?: string | null; children: ReactNode; className?: string; testId?: string }) {
  const t = useT();
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={`min-w-0 text-left ${className}`}
        aria-label={t("profile.open", { name: user.display_name })}
        data-testid={testId ?? "profile-trigger"}
        data-address={user.address}
        onClick={(e) => {
          e.stopPropagation();
          setAnchor((e.currentTarget as HTMLElement).getBoundingClientRect());
          setOpen(true);
        }}
      >
        {children}
      </button>
      {open && <ProfileCard address={user.address} node={node} anchor={anchor} onClose={() => setOpen(false)} />}
    </>
  );
}
