// SPDX-License-Identifier: Apache-2.0
import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Permission, hasPermission, parsePermissions, type RoomDetail } from "@tavrn/sdk";
import { useNode } from "../../components/NodeScope";
import { RoomIcon } from "../../components/Avatar";
import { useT } from "../../i18n";
import { describeError, toastError } from "../../stores/toasts";
import { Button, ErrorText } from "../../components/ui";
import { Section } from "./common";
import { UPLOAD_MAX_BYTES } from "./ProfileSettingsTab";

/** Room icon (design note 4.9): owner or `manage_room`; converted by the node like avatars. */
export function RoomIconSection({ room }: { room: RoomDetail }) {
  const t = useT();
  const { api } = useNode();
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canManage = hasPermission(parsePermissions(room.my_permissions), Permission.MANAGE_ROOM);
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: ["room", room.id] }), queryClient.invalidateQueries({ queryKey: ["rooms"] })]);
  const upload = async (file: File) => {
    setError(null);
    if (file.size > UPLOAD_MAX_BYTES) {
      setError(t("profile.too_large"));
      return;
    }
    setBusy(true);
    try {
      await api.rooms.uploadIcon(room.id, file);
      await refresh();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await api.rooms.deleteIcon(room.id);
      await refresh();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title={t("settings.icon")} description={t("settings.icon_hint")}>
      <div className="flex flex-wrap items-center gap-4" data-testid="room-icon-section">
        <RoomIcon room={room} size={64} testId="room-icon-preview" />
        {canManage && (
          <div className="flex flex-wrap gap-2">
            <input ref={input} type="file" accept="image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm" className="sr-only" aria-label={t("settings.icon_upload")} data-testid="room-icon-input" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
            <Button variant="ghost" disabled={busy} onClick={() => input.current?.click()}>
              {busy ? t("profile.uploading") : t("profile.upload")}
            </Button>
            {room.icon_still && (
              <Button variant="ghost" disabled={busy} onClick={() => void remove()} data-testid="room-icon-remove">
                {t("profile.remove")}
              </Button>
            )}
          </div>
        )}
      </div>
      <ErrorText>{error}</ErrorText>
    </Section>
  );
}
