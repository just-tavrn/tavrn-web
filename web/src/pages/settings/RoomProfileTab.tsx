// SPDX-License-Identifier: Apache-2.0
import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Permission, hasPermission, parsePermissions, type Member, type RoomDetail } from "@tavrn/sdk";
import { useNode } from "../../components/NodeScope";
import { MediaAvatar } from "../../components/Avatar";
import { useT } from "../../i18n";
import { useAction } from "../../hooks/useAction";
import { Button, ErrorText, Field, Input } from "../../components/ui";
import { useRoomMembers } from "../ChannelPage";
import { Section, Textarea } from "./common";
import { UPLOAD_MAX_BYTES } from "./ProfileSettingsTab";

/**
 * "My profile in this room" (design note 4.11, PROTOCOL.md §6b): nickname, avatar and bio that replace the
 * account's ones inside this room. Needs `change_nickname`; leaving the room deletes it.
 */
export function RoomProfileTab({ room }: { room: RoomDetail }) {
  const { me } = useNode();
  const members = useRoomMembers(room.id);
  const t = useT();
  const mine = members.data?.find((m) => m.user.id === me?.id);
  if (members.isPending) return <p className="text-sm text-fg-2">{t("common.loading")}</p>;
  if (!mine) return <p className="text-sm text-fg-2">{t("roomprofile.not_member")}</p>;
  return <RoomProfileForm key={`${mine.nick ?? ""}|${mine.room_bio ?? ""}`} room={room} member={mine} />;
}

function RoomProfileForm({ room, member }: { room: RoomDetail; member: Member }) {
  const { api, mediaUrl } = useProfileApi();
  const t = useT();
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [nick, setNick] = useState(member.nick ?? "");
  const [bio, setBio] = useState(member.room_bio ?? "");
  // The form's errors show inline; the avatar removal and the reset report through a toast.
  const { run: act, busy, error, setError } = useAction({ errors: "inline", refresh: () => queryClient.invalidateQueries({ queryKey: ["members", room.id] }) });
  const allowed = hasPermission(parsePermissions(room.my_permissions), Permission.CHANGE_NICKNAME);

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    void act(() => api.members.setMyProfile(room.id, { nickname: nick.trim() ? nick.trim() : null, bio }), { done: t("common.saved") });
  };
  const upload = async (file: File) => {
    if (file.size > UPLOAD_MAX_BYTES) {
      setError(t("profile.too_large"));
      return;
    }
    await act(() => api.members.uploadMyAvatar(room.id, file));
    if (input.current) input.current.value = "";
  };
  const run = (fn: () => Promise<unknown>) => act(fn, { errors: "toast" });
  const still = mediaUrl(member.room_avatar_still);
  const animated = mediaUrl(member.room_avatar);
  const name = member.nick ?? member.user.display_name;

  return (
    <div className="space-y-4" data-testid="room-profile">
      <Section title={t("roomprofile.title")} description={allowed ? t("roomprofile.hint") : t("roomprofile.forbidden")}>
        <div className="flex flex-wrap items-center gap-4">
          <MediaAvatar name={name} still={still} animated={animated && animated !== still ? animated : null} size={64} testId="room-avatar-preview" />
          {allowed && (
            <div className="flex flex-wrap gap-2">
              <input ref={input} type="file" accept="image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm" className="sr-only" aria-label={t("roomprofile.avatar_upload")} data-testid="room-avatar-input" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
              <Button variant="ghost" disabled={busy} onClick={() => input.current?.click()}>
                {busy ? t("profile.uploading") : t("roomprofile.avatar_upload")}
              </Button>
              {member.room_avatar_still && (
                <Button variant="ghost" disabled={busy} onClick={() => void run(() => api.members.deleteMyAvatar(room.id))} data-testid="room-avatar-remove">
                  {t("roomprofile.avatar_remove")}
                </Button>
              )}
            </div>
          )}
        </div>
        <form onSubmit={save} className="space-y-3">
          <Field label={t("roomprofile.nickname")} hint={t("roomprofile.nickname_hint", { name: member.user.display_name })}>
            <Input value={nick} onChange={(e) => setNick(e.target.value)} maxLength={32} disabled={!allowed} placeholder={member.user.display_name} data-testid="room-nickname" />
          </Field>
          <Field label={t("roomprofile.bio")} hint={t("roomprofile.bio_hint")}>
            <Textarea value={bio} onChange={(e) => setBio(e.target.value)} maxLength={512} rows={3} disabled={!allowed} data-testid="room-bio" />
          </Field>
          <ErrorText>{error}</ErrorText>
          {allowed && (
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="ghost" disabled={busy} onClick={() => void run(() => api.members.resetMyProfile(room.id))} data-testid="room-profile-reset">
                {t("roomprofile.reset")}
              </Button>
              <Button type="submit" disabled={busy}>
                {t("common.save")}
              </Button>
            </div>
          )}
        </form>
      </Section>
    </div>
  );
}

/** The room's node client and its media URL resolver. */
function useProfileApi() {
  const { api } = useNode();
  return { api, mediaUrl: (path: string | null | undefined) => api.mediaUrl(path) };
}
