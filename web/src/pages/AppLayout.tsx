// SPDX-License-Identifier: Apache-2.0
import { useEffect, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Navigate, Outlet, useLocation, useNavigate, useParams } from "react-router";
import { api, publicApi } from "../lib/api";
import { useAuth } from "../stores/auth";
import { useNodeRealtime, useRealtime, useRealtimeState } from "../hooks/useRealtime";
import { useT } from "../i18n";
import { AppShell, useShell } from "../components/AppShell";
import { Toaster } from "../components/Toaster";
import { PresenceMenu } from "../components/PresenceMenu";
import { NotificationBell } from "../components/NotificationCenter";
import { useNotifications } from "../stores/notifications";
import { usePush } from "../stores/push";
import { usePrivacy } from "../stores/privacy";
import { setNotificationNavigator } from "../lib/notify";
import { useE2ee } from "../stores/e2ee";
import { startSearchSync } from "../search/sync";
import { NodeBanner, NodeScope, NodeSessionBanner, useNode, useNodeUnreachable } from "../components/NodeScope";
import { skipUnlockChosen } from "./EncryptionPage";
import { ChannelSidebar } from "./ChannelSidebar";
import { RoomRail } from "../components/RoomRail";
import { MemberList } from "./MemberList";
import { ConversationMembers, HomeSidebar } from "./DirectMessages";
import { apiFor, connectNode, isHome, renewExpiring, useNodes } from "../stores/nodes";
import { syncIndex } from "../stores/conversationIndex";
import { acceptFriendInvites } from "../lib/invites";
import { getMls } from "../stores/mls";
import { VoiceBar } from "../voice/ui/VoiceBar";
import { useVoiceRealtime } from "../voice/useVoiceRealtime";
import { originUrl, platform } from "../platform";
import { announceUpdate } from "../platform/updates";
import { startDesktopShell } from "../platform/desktopShell";
import { useToasts } from "../stores/toasts";

/** Renewal check for federated sessions (before the 7-day cap). */
const RENEW_CHECK_MS = 10 * 60_000;

function StatusDot() {
  const t = useT();
  const status = useRealtimeState((s) => s.status);
  const color = status === "ready" ? "bg-brand-mint" : status === "closed" ? "bg-danger" : "bg-warn";
  const label = t(`shell.status.${status}`);
  return (
    <span className="flex items-center gap-1.5 text-xs text-fg-2" title={label} data-testid="ws-status" data-status={status}>
      <span className={`inline-block h-2 w-2 rounded-full ${color}`} aria-hidden="true" />
      {label}
    </span>
  );
}

function Footer() {
  const t = useT();
  const user = useAuth((s) => s.user);
  const remoteHome = useAuth((s) => !!s.home);
  const navigate = useNavigate();
  const { closeNav } = useShell();
  return (
    <div className="flex items-center gap-1 border-t border-line bg-bg-0 p-2">
      <PresenceMenu />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium" data-testid="me-name">
          {user?.display_name}
        </p>
        {/* Signed in with an account of another node: its full address, domain included (design note 9d). */}
        {remoteHome && (
          <p className="truncate text-[11px] text-fg-2" data-testid="me-address" title={t("auth.remote_home_hint", { domain: user?.domain ?? "" })}>
            {user?.address}
          </p>
        )}
        <StatusDot />
      </div>
      {user?.is_node_admin && !remoteHome && (
        <button type="button" aria-label={t("admin.link")} title={t("admin.link")} className="min-h-10 min-w-10 rounded-md text-fg-2 hover:bg-bg-3 hover:text-fg-0" onClick={() => { closeNav(); navigate("/admin"); }}>
          🛠
        </button>
      )}
      <NotificationBell />
      <button type="button" aria-label={t("user.settings")} title={t("user.settings")} className="min-h-10 min-w-10 rounded-md text-fg-2 hover:bg-bg-3 hover:text-fg-0" onClick={() => { closeNav(); navigate("/settings"); }}>
        ⚙
      </button>
    </div>
  );
}

/** Shown while this device cannot read encrypted data (not set up here, or locked and skipped). */
function E2eeBanner() {
  const t = useT();
  const status = useE2ee((s) => s.status);
  const user = useAuth((s) => s.user);
  const location = useLocation();
  if (!user || status === null || status === "unlocked") return null;
  const setup = !user.has_identity_key;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-warn/40 bg-warn/10 px-3 py-2 text-xs text-fg-1" data-testid="e2ee-banner">
      <span className="min-w-0 flex-1">{setup ? t("e2ee.banner_setup") : t("e2ee.banner_locked")}</span>
      <Link to={`/encryption?next=${encodeURIComponent(location.pathname)}`} className="font-medium text-accent underline underline-offset-2 hover:text-accent-hover">
        {setup ? t("e2ee.banner_setup_action") : t("e2ee.banner_unlock_action")}
      </Link>
    </div>
  );
}

/** Inside a node scope: the banner while that node is unreachable (the rest of the app keeps working). */
function ScopedNodeBanner() {
  const { domain } = useNode();
  const unreachable = useNodeUnreachable();
  const failed = useNodes((s) => s.failed[domain]);
  const queryClient = useQueryClient();
  if (failed && !unreachable) return <NodeSessionBanner domain={domain} code={failed} />;
  if (!unreachable) return null;
  return (
    <NodeBanner
      domain={domain}
      onRetry={() => {
        // Any answer marks the node reachable again; then the views load what failed.
        void apiFor(domain)
          .rooms.list()
          .then(() => queryClient.invalidateQueries())
          .catch(() => undefined);
      }}
    />
  );
}

/** Wraps the views of a room on another node in its scope (federated session, API client, banner). */
function Scoped({ node, children, quiet = false }: { node: string | null; children: ReactNode; quiet?: boolean }) {
  if (!node) return <>{children}</>;
  return (
    <NodeScope domain={node} quiet={quiet}>
      {children}
    </NodeScope>
  );
}

let updateAnnounced = false;

/** Desktop app: one update check per start, announced as a toast (Settings → App installs it). */
function useUpdateAnnouncement() {
  useEffect(() => {
    if (updateAnnounced) return;
    updateAnnounced = true;
    void announceUpdate(platform(), (toast) => useToasts.getState().push(toast));
  }, []);
}

/**
 * Notification settings of the account (home node, local storage when the node has no route yet) and the
 * navigation target of browser notifications (design note 4.11).
 */
/** Desktop app: the tray follows the voice connection, its menu and clicked notifications act here (docs/DESKTOP.md). */
function useDesktopShell(address: string | undefined) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  useEffect(() => {
    const { tray, notifications } = platform();
    if (!tray && !notifications) return;
    return startDesktopShell({ tray, notifications, queryClient, self: address ?? null, navigate: (path) => navigate(path) });
  }, [navigate, queryClient, address]);
}

function useNotificationSetup(token: string | null, address: string | undefined) {
  const navigate = useNavigate();
  useEffect(() => {
    setNotificationNavigator((path) => navigate(path));
    return () => setNotificationNavigator(null);
  }, [navigate]);
  useEffect(() => {
    if (!token || !address) return;
    void useNotifications.getState().load({ get: () => api.users.notificationSettings(), put: (s) => api.users.putNotificationSettings(s) }, address);
    // Web push of this device (PROTOCOL.md §6d): renews an enabled registration on the home node.
    const { user, deviceId } = useAuth.getState();
    void usePush.getState().init({ api, account: address, homeNode: user?.domain ?? new URL(originUrl()).hostname, deviceId: deviceId ?? null });
    return () => {
      useNotifications.getState().reset();
      usePush.getState().reset();
    };
  }, [token, address]);
}

/**
 * What the automatic image previews depend on (design note 4.12): the `auto_preview` setting of the account, the
 * node's size cap and the friends list (shared with the friends views through the query cache).
 */
function usePrivacySetup(token: string | null, address: string | undefined) {
  const friends = useQuery({ queryKey: ["friends"], queryFn: () => api.friends.list(), enabled: !!token && !!address, staleTime: 30_000 });
  useEffect(() => {
    if (!token || !address) return;
    void api.users
      .me()
      .then((me) => usePrivacy.getState().hydrate(me.auto_preview))
      .catch(() => undefined);
    void api.node
      .info()
      .then((info) => usePrivacy.getState().setMaxBytes(info.preview_auto_max_bytes))
      .catch(() => undefined);
  }, [token, address]);
  useEffect(() => {
    usePrivacy.getState().setFriends(friends.data?.friends.map((f) => f.user.address) ?? []);
  }, [friends.data]);
}

/** Keeps the index in sync and federated sessions alive while signed in. */
function useNodeHousekeeping(token: string | null, address: string | undefined) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!token || !address) return;
    // Signed in with an account of another node: this client's own node needs a federated session too.
    if (useAuth.getState().home) {
      void publicApi.node
        .wellKnown()
        .then((doc) => (isHome(doc.domain) ? undefined : connectNode(doc.domain)))
        .catch(() => undefined);
    }
    // Index first (it opens the federated sessions), then DMs of friends started elsewhere while offline.
    void syncIndex()
      .then(() => acceptFriendInvites())
      .then((nodes) => {
        if (!nodes.length) return;
        void queryClient.invalidateQueries({ queryKey: ["conversations"] });
        void queryClient.invalidateQueries({ queryKey: ["pending-invites"] });
        void getMls().then(async (m) => {
          for (const node of new Set(nodes)) await m?.processWelcomes(node).catch(() => undefined);
        });
      })
      .catch(() => undefined);
    void renewExpiring();
    const timer = setInterval(() => void renewExpiring(), RENEW_CHECK_MS);
    return () => clearInterval(timer);
  }, [token, address, queryClient]);
}

export function AppLayout() {
  const token = useAuth((s) => s.token);
  const address = useAuth((s) => s.user?.address);
  const status = useE2ee((s) => s.status);
  useRealtime();
  useNodeRealtime();
  useVoiceRealtime();
  useNodeHousekeeping(token, address);
  useNotificationSetup(token, address);
  useDesktopShell(address);
  useUpdateAnnouncement();
  usePrivacySetup(token, address);
  const { node: nodeParam, roomId, conversationId } = useParams();
  const location = useLocation();
  // The home node keeps the classic routes; other nodes live under /n/<domain>.
  const node = nodeParam && !isHome(nodeParam) ? nodeParam : null;
  useEffect(() => {
    if (!token || !address) return;
    void useE2ee
      .getState()
      .refresh()
      .then((s) => {
        if (s === "unlocked") void useE2ee.getState().ensureDevice();
      });
  }, [token, address]);
  // Background sync of the local search index while this device can decrypt (design note 4.4).
  useEffect(() => {
    if (!token || status !== "unlocked") return;
    return startSearchSync();
  }, [token, status]);
  if (!token) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  if (nodeParam && !node) return <Navigate to={location.pathname.replace(`/n/${nodeParam}`, "") || "/"} replace />;
  // Lock on close: a new tab must unlock before anything else (unless the user chose to skip in this tab).
  if (status === "locked" && !skipUnlockChosen()) return <Navigate to={`/encryption?next=${encodeURIComponent(location.pathname)}`} replace />;

  return (
    <>
      <AppShell
        headerExtra={<NotificationBell />}
        rail={<RoomRail />}
        sidebar={
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto">
              {roomId ? (
                <Scoped node={node} quiet>
                  <ChannelSidebar roomId={roomId} />
                </Scoped>
              ) : (
                <HomeSidebar />
              )}
            </div>
            <VoiceBar />
            <Footer />
          </div>
        }
        aside={
          roomId ? (
            <Scoped node={node} quiet>
              <MemberList roomId={roomId} />
            </Scoped>
          ) : conversationId ? (
            <Scoped node={node} quiet>
              <ConversationMembers conversationId={conversationId} />
            </Scoped>
          ) : null
        }
      >
        <E2eeBanner />
        <Scoped node={node}>
          {node && <ScopedNodeBanner />}
          <Outlet />
        </Scoped>
      </AppShell>
      <Toaster />
    </>
  );
}

