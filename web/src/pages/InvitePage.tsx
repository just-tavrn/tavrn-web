// SPDX-License-Identifier: Apache-2.0
/**
 * The invite page `/invite/:code`. Signed out it previews the invite (the public `GET /invites/{code}`, without
 * credentials): the room, its rules read-only and its documents, with "Sign in to join" and, where the node takes new
 * accounts, "Create an account"; both come back here (`next`, a same-origin path). Signed in it shows the join block
 * with the rules checkbox; the room is joined only by the "Join" button, never by itself after a sign-in.
 */
import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import { isAdult, isNodeDomain, type PublicRoom } from "@tavrn/sdk";
import { api, publicApi } from "../lib/api";
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
import { useAgeStatus } from "../lib/age";

export function InvitePage() {
  const { code = "" } = useParams();
  const [search] = useSearchParams();
  const token = useAuth((s) => s.token);
  // Invite links belong to the node that served this page: with an account of another node, that
  // node is reached through its federated session. An app link of another node names it (`?node=`, docs/ANDROID.md).
  const named = search.get("node")?.toLowerCase() ?? null;
  const other = named && isNodeDomain(named) && named !== useAuth.getState().user?.domain ? named : null;
  const back = `/invite/${encodeURIComponent(code)}${other ? `?node=${encodeURIComponent(other)}` : ""}`;
  if (!token) {
    // Another node's invite: signed out, nothing is fetched from a node the link names; the sign-in comes first.
    if (other) return <Navigate to={`/login?next=${encodeURIComponent(back)}`} replace />;
    return <SignedOutInvite code={code} back={back} />;
  }
  return <SignedInInvite code={code} other={other} />;
}

function InviteCard({ children }: { children: ReactNode }) {
  return (
    <div role="main" className="flex min-h-full items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-xl border border-line bg-bg-1 p-6 text-center shadow-xl">
        {children}
        <LegalLink className="mt-4" />
      </div>
    </div>
  );
}

/** Icon, name, description, members and the node the room lives on. */
function InviteHead({ room, node, domain }: { room: PublicRoom; node: string | null; domain: string | null }) {
  const t = useT();
  return (
    <>
      <div className="flex justify-center">
        <RoomIcon room={room} size={64} node={node} />
      </div>
      <p className="mt-3 text-sm text-fg-2">{t("invite.invited_to")}</p>
      <h1 className="break-words text-lg font-semibold" data-testid="invite-room-name">
        {room.name}
      </h1>
      {room.description && (
        <p className="mt-1 line-clamp-4 whitespace-pre-line break-words text-sm text-fg-1" data-testid="invite-room-description">
          {room.description}
        </p>
      )}
      <p className="mt-1 text-xs text-fg-2">
        {t("invite.members", { count: room.member_count })}
        {domain ? ` · ${t("invite.on_node", { node: domain })}` : ""}
      </p>
    </>
  );
}

const actionLink = "inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-md px-3 text-sm font-medium transition";

/**
 * A signed-out visitor: the preview from this node's public route (no token, no refresh, nothing stored about the
 * visitor) and the way to sign in or register, back to this invite afterwards.
 */
function SignedOutInvite({ code, back }: { code: string; back: string }) {
  const t = useT();
  const domain = useOriginDomain();
  const preview = useQuery({ queryKey: ["invite", "public", code], queryFn: () => publicApi.invites.preview(code), retry: false });
  // Registration as the sign-in page shows it (same cache entry): closed or SSO-only nodes get no "Create an account".
  const nodeInfo = useQuery({ queryKey: ["node", "origin"], queryFn: () => publicApi.node.info() });
  const registration = nodeInfo.data && !nodeInfo.data.sso?.only ? nodeInfo.data.registration : "closed";
  const next = encodeURIComponent(back);
  return (
    <InviteCard>
      {preview.isPending && <p className="text-sm text-fg-2">{t("invite.loading")}</p>}
      {preview.isError && (
        <div className="space-y-3" data-testid="invite-invalid">
          <ErrorText>{describeError(preview.error)}</ErrorText>
          <Link to="/login" className={`${actionLink} border border-line text-fg-1 hover:bg-bg-3 hover:text-fg-0`}>
            {t("invite.preview.to_signin")}
          </Link>
        </div>
      )}
      {preview.data && (
        <>
          <InviteHead room={preview.data.room} node={null} domain={domain} />
          <div className="mt-4">
            <RoomJoinBlock info={preview.data} node={null} accepted={false} onAcceptedChange={() => {}} head={false} page readOnly />
          </div>
          {preview.data.room.age_gate === "adults_only" && (
            <p className="mt-4 rounded-md border border-line bg-bg-0 px-3 py-2 text-sm text-fg-1" data-testid="invite-adults-only">
              {t("invite.preview.adults_only")}
            </p>
          )}
          <p className="mt-4 text-sm text-fg-2">{t("invite.preview.hint")}</p>
          <div className="mt-3 space-y-2">
            <Link to={`/login?next=${next}`} className={`${actionLink} bg-accent text-accent-text hover:bg-accent-hover`} data-testid="invite-signin">
              {t("invite.preview.signin")}
            </Link>
            {registration !== "closed" && (
              <>
                <Link to={`/login?mode=register&next=${next}`} className={`${actionLink} border border-line text-fg-1 hover:bg-bg-3 hover:text-fg-0`} data-testid="invite-register">
                  {t("invite.preview.register")}
                </Link>
                {registration === "invite" && <p className="text-xs text-fg-2">{t("auth.invite_hint")}</p>}
              </>
            )}
          </div>
        </>
      )}
    </InviteCard>
  );
}

function SignedInInvite({ code, other }: { code: string; other: string | null }) {
  const t = useT();
  const remoteHome = useAuth((s) => !!s.home);
  const origin = useOriginDomain();
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
    <InviteCard>
      {preview.isPending && <p className="text-sm text-fg-2">{t("invite.loading")}</p>}
      {preview.isError && <ErrorText>{describeError(preview.error)}</ErrorText>}
      {preview.data && (
        <>
          <InviteHead room={preview.data.room} node={node} domain={node ?? origin} />
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
    </InviteCard>
  );
}
