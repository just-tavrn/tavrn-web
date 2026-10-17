// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import { isNodeDomain } from "@tavrn/sdk";
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
import { RoomJoinBlock, hasRules } from "../components/JoinRoomDialog";
import { LegalLink } from "../components/legal/LegalLink";
import { isAdult } from "@tavrn/sdk";
import { useAgeStatus } from "../lib/age";

export function InvitePage() {
  const t = useT();
  const { code = "" } = useParams();
  const [search] = useSearchParams();
  const token = useAuth((s) => s.token);
  // Invite links belong to the node that served this page: with an account of another node, that
  // node is reached through its federated session. An app link of another node names it (`?node=`, docs/ANDROID.md).
  const remoteHome = useAuth((s) => !!s.home);
  const origin = useOriginDomain();
  const named = search.get("node")?.toLowerCase() ?? null;
  const other = named && isNodeDomain(named) && named !== useAuth.getState().user?.domain ? named : null;
  const node = other ?? (remoteHome ? origin : null);
  const client = node ? apiFor(node) : api;
  const preview = useQuery({ queryKey: ["invite", code, node], queryFn: async () => {
      // Another node's link: its federated session first (as the join dialog does).
      if (other) await connectNode(other);
      return client.invites.preview(code);
    },
    enabled: !!other || !remoteHome || !!origin });
  const [accepted, setAccepted] = useState(false);
  // Age gates (PROTOCOL.md §5e): the preview names the gate, the own status decides; the node refuses anyway.
  const ageStatus = useAgeStatus();
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  if (!token) return <Navigate to={`/login?next=${encodeURIComponent(`/invite/${code}${other ? `?node=${encodeURIComponent(other)}` : ""}`)}`} replace />;

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
            {/* The join block of every join path (components/JoinRoomDialog.tsx): rules with the checkbox, documents. */}
            <div className="mt-4">
              <RoomJoinBlock info={preview.data} node={node} accepted={accepted} onAcceptedChange={setAccepted} head={false} page />
            </div>
            {preview.data.room.age_gate === "adults_only" && !isAdult(ageStatus) && ageStatus !== undefined && (
              <p role="status" className="mt-4 rounded-md border border-line bg-bg-0 px-3 py-2 text-sm text-fg-1" data-testid="invite-age-restricted">
                {t("age.invite.restricted")}
              </p>
            )}
            <ErrorText>{error}</ErrorText>
            <Button className="mt-4 w-full" onClick={() => void join()} disabled={(hasRules(preview.data) && !accepted) || (preview.data.room.age_gate === "adults_only" && !isAdult(ageStatus))}>
              {t("invite.join")}
            </Button>
          </>
        )}
        <LegalLink className="mt-4" />
      </div>
    </div>
  );
}
