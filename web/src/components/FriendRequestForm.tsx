// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n";
import { describeError, useToasts } from "../stores/toasts";
import { Button, ErrorText, Input } from "./ui";

/** Maximum length of a friend request message and of a block note (design note 4.9). */
export const NOTE_MAX = 256;

/**
 * Sends a friend request with an optional message (design note 4.9). With `user` the address is fixed (a
 * profile, the "friends only" notice); without it the address is typed in.
 */
export function FriendRequestForm({ user, onSent, compact = false }: { user?: string; onSent?: () => void; compact?: boolean }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [target, setTarget] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const address = (user ?? target).trim();
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.friends.request(address, message.trim() || null);
      useToasts.getState().push({ kind: "info", title: t(r.status === "accepted" ? "friends.now_friends" : "friends.request_sent", { address: r.user.address }) });
      setTarget("");
      setMessage("");
      await queryClient.invalidateQueries({ queryKey: ["friends"] });
      onSent?.();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className={compact ? "space-y-2" : "flex max-w-xl flex-col gap-2"}
      data-testid="friend-request-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (address) void send();
      }}
    >
      {!user && <Input aria-label={t("friends.add_label")} placeholder={t("friends.add_placeholder")} value={target} onChange={(e) => setTarget(e.target.value)} autoComplete="off" />}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input aria-label={t("friends.message_label")} placeholder={t("friends.message_placeholder")} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={NOTE_MAX} autoComplete="off" name="friend_message" />
        <Button type="submit" disabled={busy || !address} className="shrink-0">
          {t("friends.add")}
        </Button>
      </div>
      <ErrorText>{error}</ErrorText>
    </form>
  );
}
