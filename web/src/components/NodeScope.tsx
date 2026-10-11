// SPDX-License-Identifier: Apache-2.0
/**
 * Which node a room view talks to. Room and conversation ids are node-scoped: the home node's rooms keep
 * their routes (`/rooms/<id>/…`), rooms of other nodes live under `/n/<domain>/rooms/<id>/…`. Views
 * below a {@link NodeScope} get that node's API client, the user as that node knows it (node-local user
 * id) and the matching route builder through {@link useNode}; without a scope they get the home node.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { TavrnApiError, type TavrnApi, type UserPrivate } from "@tavrn/sdk";
import { api } from "../lib/api";
import { useNavigate } from "react-router";
import { useAuth } from "../stores/auth";
import { useConversationIndex } from "../stores/conversationIndex";
import { apiFor, confirmNode, connectNode, isHome, nodeNeedsNoConfirmation, useNodes } from "../stores/nodes";
import { useReach } from "../stores/reach";
import { describeError, toastError } from "../stores/toasts";
import { useT } from "../i18n";
import { Button } from "./ui";
import { PeerBlocked, PeerWarning } from "./PeerWarning";

export interface NodeContextValue {
  /** Domain of the node; the home domain for the home node. */
  domain: string;
  home: boolean;
  api: TavrnApi;
  /** The user as this node knows it. */
  me: UserPrivate | null;
}

const NodeContext = createContext<NodeContextValue | null>(null);

/** Route of a room (and channel) on `domain` (home: the classic routes). */
export function roomPath(domain: string | null | undefined, roomId: string, channelId?: string, rest?: string): string {
  const base = isHome(domain) ? `/rooms/${roomId}` : `/n/${domain}/rooms/${roomId}`;
  if (channelId) return `${base}/channels/${channelId}`;
  return rest ? `${base}/${rest}` : base;
}

/** Route of a DM or group DM hosted on `domain` (home: `/conversations/<id>`). */
export function conversationPath(domain: string | null | undefined, conversationId: string): string {
  return isHome(domain) ? `/conversations/${conversationId}` : `/n/${domain}/conversations/${conversationId}`;
}

export function useNode(): NodeContextValue & { roomPath: (roomId: string, channelId?: string, rest?: string) => string } {
  const scoped = useContext(NodeContext);
  const user = useAuth((s) => s.user);
  const value = scoped ?? { domain: user?.domain ?? "", home: true, api, me: user };
  return { ...value, roomPath: (roomId, channelId, rest) => roomPath(value.home ? null : value.domain, roomId, channelId, rest) };
}

/** `true` while the node of the current scope answers no requests. */
export function useNodeUnreachable(): boolean {
  const { domain } = useNode();
  return useReach((s) => s.nodes[domain] === "unreachable");
}

/** Banner for a node that cannot be reached; only that node's views show it. */
export function NodeBanner({ domain, onRetry }: { domain: string; onRetry: () => void }) {
  const t = useT();
  return (
    <div role="status" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-danger/40 bg-danger/10 px-3 py-2 text-xs text-fg-1" data-testid="node-unreachable-banner" data-node={domain}>
      <span className="min-w-0 flex-1">{t("node.offline", { domain })}</span>
      <Button variant="ghost" className="min-h-8 px-2 text-xs" onClick={onRetry}>
        {t("node.retry")}
      </Button>
    </div>
  );
}

/**
 * The federated session of `domain` could not be renewed because a node refused it: only this node asks
 * the user to sign in there again (a fresh federation token of the home node); the rest keeps working.
 */
export function NodeSessionBanner({ domain, code }: { domain: string; code: string }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const reconnect = async () => {
    setBusy(true);
    try {
      await connectNode(domain, { force: true });
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div role="alert" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-warn/40 bg-warn/10 px-3 py-2 text-xs text-fg-1" data-testid="node-session-banner" data-node={domain} data-code={code}>
      <span className="min-w-0 flex-1">{t("node.session_ended", { domain })}</span>
      <Button variant="ghost" className="min-h-8 px-2 text-xs" disabled={busy} onClick={() => void reconnect()}>
        {t("node.sign_in_again")}
      </Button>
    </div>
  );
}

/**
 * Whether the account may sign in on `domain` without asking: a known session, a confirmation in this tab, this client's
 * own node, or an entry of the conversation index (the account has rooms or conversations there).
 */
async function knownNode(domain: string): Promise<boolean> {
  if (await nodeNeedsNoConfirmation(domain)) return true;
  const index = useConversationIndex.getState();
  const state = index.state ?? (await index.load().catch(() => null));
  return !!state?.items.some((e) => e.node === domain);
}

/**
 * Asked before the first sign-in on a node the account has nothing on (a link to `/n/<domain>/…`): signing in tells
 * that node the account's address, IP address and online times. Nothing is stored before the user agrees.
 */
function ConnectConfirm({ domain, onConfirm }: { domain: string; onConfirm: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const address = useAuth((s) => s.user?.address ?? "");
  return (
    <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto p-4 sm:items-center">
      <section aria-labelledby="node-connect-title" className="w-full max-w-md rounded-lg border border-line bg-bg-1 p-4" data-testid="node-connect-confirm" data-node={domain}>
        <h2 id="node-connect-title" className="break-words text-base font-semibold text-fg-0">
          {t("node.connect_confirm_title", { domain, address })}
        </h2>
        <p className="mt-2 break-words text-sm text-fg-1">{t("node.connect_confirm_body", { domain })}</p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={() => navigate("/")}>
            {t("common.cancel")}
          </Button>
          <Button onClick={onConfirm}>{t("node.connect_confirm")}</Button>
        </div>
      </section>
    </div>
  );
}

/**
 * Scope of a node other than the home node: makes sure a federated session exists (federation token of
 * the home node, `POST /auth/federated` there) before rendering, and shows the unreachable state with a
 * retry instead of the content when the node is down. A first sign-in on a node the account has nothing on asks
 * first ({@link ConnectConfirm}). `quiet` scopes (side panels) render nothing until the session exists and never ask.
 */
export function NodeScope({ domain, children, quiet = false }: { domain: string; children: ReactNode; quiet?: boolean }) {
  const t = useT();
  const session = useNodes((s) => s.sessions[domain]);
  const unreachable = useReach((s) => s.nodes[domain] === "unreachable");
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [ask, setAsk] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setAsk(false);
    void knownNode(domain).then((known) => {
      if (cancelled) return;
      if (!known) return setAsk(true);
      connectNode(domain).catch((e: unknown) => !cancelled && setError(e));
    });
    return () => {
      cancelled = true;
    };
  }, [domain, attempt]);
  const value = useMemo<NodeContextValue>(() => ({ domain, home: false, api: apiFor(domain), me: session?.user ?? null }), [domain, session?.user]);
  const retry = () => {
    useReach.getState().set(domain, "ok");
    setAttempt((n) => n + 1);
  };
  if (!session) {
    if (quiet) return null;
    if (ask) {
      return (
        <ConnectConfirm
          domain={domain}
          onConfirm={() => {
            confirmNode(domain);
            setAttempt((n) => n + 1);
          }}
        />
      );
    }
    // The home node refuses federation tokens for a node it blocks (FEDERATION.md §1.5, §9.4).
    if (!unreachable && error instanceof TavrnApiError && error.code === "federation.peer_blocked") return <PeerBlocked domain={domain} />;
    if (unreachable || error) {
      return (
        <div className="flex min-h-0 flex-1 flex-col">
          <NodeBanner domain={domain} onRetry={retry} />
          {!unreachable && !!error && <p className="p-4 text-sm text-danger">{describeError(error)}</p>}
        </div>
      );
    }
    return <p className="p-4 text-sm text-fg-2">{t("node.connecting_to", { domain })}</p>;
  }
  return (
    <NodeContext.Provider value={value}>
      <PeerWarning domain={domain} quiet={quiet}>
        {children}
      </PeerWarning>
    </NodeContext.Provider>
  );
}

