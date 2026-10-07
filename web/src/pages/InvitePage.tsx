// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, useNavigate, useParams } from "react-router";
import { api } from "../lib/api";
import { useAuth } from "../stores/auth";
import { useOriginDomain } from "../lib/origin";
import { apiFor, connectNode } from "../stores/nodes";
import { indexJoinedRoom } from "../stores/conversationIndex";
import { roomPath } from "../components/NodeScope";
import { useT } from "../i18n";
import { describeError } from "../stores/toasts";
import { Button, ErrorText } from "../components/ui";
import { RoomIcon } from "../components/Avatar";
import { LegalLink } from "../components/legal/LegalLink";

export function InvitePage() {
  const t = useT();
  const { code = "" } = useParams();
  const token = useAuth((s) => s.token);
  // Invite links belong to the node that served this page: with an account of another node, that
  // node is reached through its federated session.
  const remoteHome = useAuth((s) => !!s.home);
  const origin = useOriginDomain();
  const node = remoteHome ? origin : null;
  const client = node ? apiFor(node) : api;
  const preview = useQuery({ queryKey: ["invite", code, node], queryFn: () => client.invites.preview(code), enabled: !remoteHome || !!origin });
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  if (!token) return <Navigate to={`/login?next=${encodeURIComponent(`/invite/${code}`)}`} replace />;

  const join = async () => {
    setError(null);
    try {
      if (node) await connectNode(node);
      const room = await client.invites.join(code, { accept_rules: accepted });
      void indexJoinedRoom(node, room.id);
      await queryClient.invalidateQueries({ queryKey: ["rooms"] });
      navigate(roomPath(node, room.id), { replace: true });
    } catch (e) {
      setError(describeError(e) || t("invite.failed"));
    }
  };

  return (
    <div role="main" className="flex min-h-full items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-xl border border-line bg-bg-1 p-6 text-center shadow-xl">
        {preview.isPending && <p className="text-sm text-fg-2">{t("invite.loading")}</p>}
        {preview.isError && <ErrorText>{describeError(preview.error)}</ErrorText>}
        {preview.data && (
          <>
            <div className="flex justify-center">
              <RoomIcon room={preview.data.room} size={64} node={node} />
            </div>
            <p className="mt-3 text-sm text-fg-2">{t("invite.invited_to")}</p>
            <h1 className="text-lg font-semibold" data-testid="invite-room-name">
              {preview.data.room.name}
            </h1>
            <p className="text-xs text-fg-2">{t("invite.members", { count: preview.data.room.member_count })}</p>
            {preview.data.rules && (
              <div className="mt-4 rounded-md border border-line bg-bg-0 p-3 text-left text-sm">
                <p className="mb-1 font-medium">{t("invite.rules")}</p>
                <p className="whitespace-pre-wrap text-fg-1">{preview.data.rules}</p>
                <label className="mt-3 flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} className="h-5 w-5" /> {t("invite.accept_rules")}
                </label>
              </div>
            )}
            <ErrorText>{error}</ErrorText>
            <Button className="mt-4 w-full" onClick={() => void join()} disabled={!!preview.data.rules && !accepted}>
              {t("invite.join")}
            </Button>
          </>
        )}
        <LegalLink className="mt-4" />
      </div>
    </div>
  );
}
