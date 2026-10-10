// SPDX-License-Identifier: Apache-2.0
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { useT } from "../i18n";
import { describeError } from "../stores/toasts";
import { useAuth } from "../stores/auth";
import { ConversationView } from "../components/ConversationView";
import { NodeScope, useNode } from "../components/NodeScope";
import { RequestActions, requestPath, useMessageRequests, type RequestItem } from "../components/MessageRequests";
import { MediaAvatar } from "../components/Avatar";
import { formatTime } from "../lib/format";

/** All open message requests (`/requests`). */
export function MessageRequestsPage() {
  const t = useT();
  const requests = useMessageRequests();
  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-6">
      <h1 className="text-xl font-semibold">{t("requests.title")}</h1>
      <p className="mt-1 max-w-2xl text-sm text-fg-2">{t("requests.intro")}</p>
      {requests.isError && <p className="mt-4 text-sm text-danger">{describeError(requests.error)}</p>}
      {requests.data?.length === 0 && <p className="mt-4 text-sm text-fg-2">{t("requests.none")}</p>}
      <ul className="mt-4 space-y-3" data-testid="request-list">
        {requests.data?.map((r) => (
          <li key={`${r.node ?? ""}/${r.conversationId}`} className="rounded-lg border border-line bg-bg-1 p-3" data-testid="request" data-from={r.from}>
            <RequestSummary request={r} />
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Link to={requestPath(r)} className="inline-flex min-h-10 items-center rounded-md px-3 text-sm font-medium text-accent hover:bg-bg-3" data-testid="request-open">
                {t("requests.open")}
              </Link>
              <RequestActions request={r} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Sender (full address), shared rooms, hosting node and time. */
function RequestSummary({ request: r }: { request: RequestItem }) {
  const t = useT();
  return (
    <div className="flex min-w-0 items-start gap-3">
      <MediaAvatar name={r.fromName} size={40} />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{r.fromName}</p>
        <p className="truncate text-xs text-fg-2" data-testid="request-from">
          {r.from}
          {r.node ? ` · ${t("requests.remote", { node: r.node })}` : ""}
        </p>
        <p className="mt-1 text-xs text-fg-1" data-testid="request-shared">
          {r.sharedRooms.length ? t("requests.shared_rooms", { rooms: r.sharedRooms.join(", ") }) : t("requests.no_shared_rooms")}
        </p>
        <p className="text-xs text-fg-2">
          {formatTime(r.createdAt)} · {t(r.kind === "group" ? "requests.kind_group" : "requests.kind_dm")}
        </p>
      </div>
    </div>
  );
}

/**
 * One request opened (`/requests/<domain|home>/<id>`): read the messages, then accept or decline. The
 * route params are not called `node`/`conversationId` on purpose: the layout reads those for its scope.
 */
export function MessageRequestPage() {
  const { host = "home", requestId: conversationId = "" } = useParams();
  const domain = host === "home" ? null : host;
  const content = <RequestView domain={domain} conversationId={conversationId} />;
  return domain ? <NodeScope domain={domain}>{content}</NodeScope> : content;
}

function RequestView({ domain, conversationId }: { domain: string | null; conversationId: string }) {
  const t = useT();
  const { api, me } = useNode();
  const requests = useMessageRequests();
  const conv = useQuery({ queryKey: ["conversation", conversationId], queryFn: () => api.conversations.get(conversationId) });
  const fallbackDomain = useAuth((s) => s.user?.domain ?? "");
  const request = requests.data?.find((r) => r.conversationId === conversationId && r.node === domain);
  const members = useMemo(() => conv.data?.members.map((m) => m.address) ?? null, [conv.data]);
  if (conv.isPending) return <p className="p-4 text-sm text-fg-2">{t("common.loading")}</p>;
  if (conv.isError) return <p className="p-4 text-sm text-danger">{describeError(conv.error)}</p>;
  const c = conv.data;
  const pending = c.pending?.includes(me?.address ?? "");
  const sender = c.members.find((m) => m.address === c.creator) ?? c.members.find((m) => m.address !== me?.address);
  const header = (
    <>
      <span className="text-fg-2" aria-hidden="true">
        ✉
      </span>
      <h1 className="truncate text-sm font-semibold" data-testid="request-title">
        {sender?.display_name ?? t("requests.title")}
      </h1>
      {sender && <span className="hidden truncate text-xs text-fg-2 sm:inline">{sender.address}</span>}
    </>
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {pending && request && (
        <div className="shrink-0 space-y-2 border-b border-line bg-bg-1 p-3" data-testid="request-banner">
          <RequestSummary request={request} />
          <p className="text-sm text-fg-1">{t("requests.banner", { name: request.fromName })}</p>
          <RequestActions request={request} />
        </div>
      )}
      <ConversationView
        key={c.id}
        conversationId={c.id}
        encrypted
        header={header}
        placeholder={t("requests.accept_to_reply")}
        canSend={!pending}
        noPermissionReason={t("requests.accept_to_reply")}
        canManage={false}
        canAttach={false}
        canReact={false}
        canPin={false}
        members={members}
        direct={members ?? undefined}
        people={c.members}
        mayManage={false}
        domain={domain ?? fallbackDomain}
      />
    </div>
  );
}
