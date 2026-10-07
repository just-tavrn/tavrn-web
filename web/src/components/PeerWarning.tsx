// SPDX-License-Identifier: Apache-2.0
/**
 * Client checks of another node (FEDERATION.md §9.2). For every node other than the home node the client
 * asks its home node how it sees that node (`GET /federation/peers/{domain}/state`) and compares the
 * node's signing keys from its own fetch of the discovery document with the home node's view:
 *
 * - the home node blocks the node (or does not federate with it): its views are replaced by a warning;
 * - the keys differ (split view or interception): its views are replaced by a warning;
 * - the node failed the home node's conformance check: a warning banner above its views.
 *
 * Everything else (no answer, a browser that cannot fetch the document itself) shows nothing: these
 * checks add warnings, they never make a working node unusable on their own.
 */
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { TavrnApi, b64urlDecode, b64urlEncode, discoverNode, type KeyFingerprint, type PeerPublicState } from "@tavrn/sdk";
import { CLIENT_HEADER, homeBase } from "../lib/api";
import { useT } from "../i18n";

/** Public client of the home node (no session, no reachability tracking: failures here are silent). */
const homePublic = new TavrnApi({ baseUrl: homeBase, clientHeader: CLIENT_HEADER, fetchImpl: (input, init) => globalThis.fetch(input, init) });

/** Replaceable pieces (tests). */
export const peerDeps = {
  state: (domain: string): Promise<PeerPublicState> => homePublic.federation.peerState(domain),
  /** Key fingerprints from the client's own fetch of the document, or null if the browser cannot fetch it. */
  ownKeys: async (domain: string): Promise<KeyFingerprint[] | null> => {
    try {
      const doc = await discoverNode(domain);
      if (doc.domain !== domain) return null;
      return await fingerprints(doc.keys ?? []);
    } catch {
      return null;
    }
  },
};

/** `kid` and base64url SHA-256 of the 32 key bytes, as the node reports them. */
export async function fingerprints(keys: Array<{ kid: string; x: string }>): Promise<KeyFingerprint[]> {
  const out: KeyFingerprint[] = [];
  for (const k of keys) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", b64urlDecode(k.x));
    out.push({ kid: k.kid, sha256: b64urlEncode(new Uint8Array(digest)) });
  }
  return out;
}

/** `true` if a `kid` both views know names different keys. */
export function keysDiffer(own: KeyFingerprint[] | null | undefined, home: KeyFingerprint[] | null | undefined): boolean {
  if (!own || !home) return false;
  return own.some((k) => home.some((h) => h.kid === k.kid && h.sha256 !== k.sha256));
}

function Warning({ domain, text, testId, blocking }: { domain: string; text: string; testId: string; blocking: boolean }) {
  return (
    <div role="alert" className={`flex shrink-0 items-start gap-2 border-b px-3 py-2 text-xs text-fg-1 ${blocking ? "border-danger/40 bg-danger/10" : "border-warn/40 bg-warn/10"}`} data-testid={testId} data-node={domain}>
      <span aria-hidden="true">⚠</span>
      <span className="min-w-0 flex-1 break-words">{text}</span>
    </div>
  );
}

/** The warning shown instead of a node's views while the home node does not federate with it. */
export function PeerBlocked({ domain }: { domain: string }) {
  const t = useT();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Warning domain={domain} text={t("peer.blocked", { domain })} testId="peer-blocked" blocking />
    </div>
  );
}

/** Wraps the views of another node; `quiet` scopes (side panels) show no banners and nothing when blocked. */
export function PeerWarning({ domain, quiet = false, children }: { domain: string; quiet?: boolean; children: ReactNode }) {
  const t = useT();
  const state = useQuery({ queryKey: ["peer-state", domain], queryFn: () => peerDeps.state(domain), staleTime: 5 * 60_000, retry: false });
  const own = useQuery({ queryKey: ["peer-own-keys", domain], queryFn: () => peerDeps.ownKeys(domain), staleTime: 60 * 60_000, retry: false });
  const differ = keysDiffer(own.data, state.data?.keys);
  if (quiet) return state.data?.blocked || differ ? null : <>{children}</>;
  if (state.data?.blocked) return <PeerBlocked domain={domain} />;
  if (differ) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <Warning domain={domain} text={t("peer.keys_differ", { domain })} testId="peer-keys-differ" blocking />
      </div>
    );
  }
  return (
    <>
      {state.data?.conformance === "fail" && <Warning domain={domain} text={t("peer.failed_check", { domain })} testId="peer-failed-check" blocking={false} />}
      {children}
    </>
  );
}
