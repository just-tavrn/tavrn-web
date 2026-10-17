// SPDX-License-Identifier: Apache-2.0
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";
import { useAuth } from "../stores/auth";
import { useT } from "../i18n";
import { Button } from "../components/ui";
import { RoomIcon } from "../components/Avatar";
import { toastError } from "../stores/toasts";
import { indexJoinedRoom } from "../stores/conversationIndex";
import { apiFor, isHome, useNodes } from "../stores/nodes";
import { useOriginDomain } from "../lib/origin";
import { roomPath } from "../components/NodeScope";
import { InviteList } from "../components/InviteList";
import { useJoinFlow } from "../components/JoinRoomDialog";

/** Public rooms of the home node, or of another node (`domain`) through its federated session. */
function DiscoverSection({ domain }: { domain: string | null }) {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const session = useNodes((s) => (domain ? s.sessions[domain] : null));
  const client = apiFor(domain);
  const discover = useQuery({ queryKey: domain ? ["discover", domain] : ["discover"], queryFn: () => client.rooms.discover(), enabled: !domain || !!session });
  const flow = useJoinFlow();
  // Rules and the room's documents first when it has any (components/JoinRoomDialog.tsx, tavrn-web#195).
  const join = async (id: string) => {
    try {
      await flow.start(
        () => client.rooms.preview(id),
        async (acceptRules) => {
          await client.rooms.join(id, { accept_rules: acceptRules });
          void indexJoinedRoom(domain, id);
          await queryClient.invalidateQueries({ queryKey: ["rooms"] });
          navigate(roomPath(domain, id));
        },
        domain,
      );
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <section data-testid={domain ? "discover-node" : undefined} data-node={domain ?? undefined}>
      <h2 className="mt-8 text-sm font-semibold uppercase tracking-wide text-fg-2">{domain ? t("home.public_rooms_on", { domain }) : t("home.public_rooms")}</h2>
      {discover.isPending && <p className="mt-2 text-sm text-fg-2">{t("common.loading")}</p>}
      {discover.data?.length === 0 && <p className="mt-2 text-sm text-fg-2">{t("home.no_public_rooms")}</p>}
      <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid={domain ? undefined : "discover-list"}>
        {discover.data?.map((r) => (
          <li key={r.id} className="flex items-center gap-3 rounded-lg border border-line bg-bg-1 p-3">
            <RoomIcon room={r} size={40} node={domain} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{r.name}</p>
              <p className="truncate text-xs text-fg-2">
                {t("invite.members", { count: r.member_count })}
                {r.description ? ` · ${r.description}` : ""}
              </p>
            </div>
            <Button variant="ghost" onClick={() => void join(r.id)}>
              {t("home.join")}
            </Button>
          </li>
        ))}
      </ul>
      {flow.overlay}
    </section>
  );
}

export function HomePage() {
  const t = useT();
  const user = useAuth((s) => s.user);
  const remoteHome = useAuth((s) => !!s.home);
  const origin = useOriginDomain();
  return (
    <div className="flex-1 overflow-y-auto p-6">
      <h1 className="text-xl font-semibold">{t("home.welcome", { name: user?.display_name ?? "" })}</h1>
      <p className="mt-1 text-sm text-fg-1">{t("home.intro")}</p>
      <Link to="/discover" className="mt-2 inline-block text-sm font-medium text-accent hover:text-accent-hover hover:underline" data-testid="home-discover-link">
        {t("discover.link")} →
      </Link>
      <InviteList />
      {/* Signed in with an account of another node: the rooms of the node this client belongs to. */}
      {remoteHome && origin && !isHome(origin) && <DiscoverSection domain={origin} />}
      <DiscoverSection domain={null} />
    </div>
  );
}
