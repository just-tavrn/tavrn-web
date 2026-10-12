// SPDX-License-Identifier: Apache-2.0
/**
 * Deep links into the apps (docs/DESKTOP.md "Links into the app"): a link from outside (`tavrn://…`, Android's App
 * Links) never navigates by itself. The dialog names the target (an invite, a room or channel, an application to add,
 * with the node) and the link itself; only "Open" goes there. An app without a home node yet keeps the link and offers
 * the node picker with the link's node filled in; after the choice (a reload) the link is offered again.
 * `tavrn://connect` (the browser's way back after the sign-in on the node's page) shows nothing: it only wakes the
 * sign-in that waits for exactly that session and state (`appSession.ts`). Outside the apps this renders nothing.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useT } from "../i18n";
import { platform, webOrigin } from "../platform";
import { nudgeAppSession } from "../platform/appSession";
import { deepLinkRoute, keepPendingLink, parseDeepLink, takePendingLink, type DeepLinkTarget } from "../platform/deepLinks";
import { stripBidi } from "../lib/untrusted";
import { Button, Dialog } from "./ui";

/** Replaceable pieces (tests). */
export const deepLinkDeps = {
  identity: undefined as ((host: string) => Promise<string | null>) | undefined,
};

interface Offer {
  link: string;
  target: Exclude<DeepLinkTarget, { kind: "connect" }>;
}

function offerOf(link: string): Offer | null {
  const target = parseDeepLink(link);
  if (!target) return null;
  if (target.kind === "connect") {
    nudgeAppSession(target.session, target.state);
    return null;
  }
  return { link, target };
}

export function DeepLinkPrompt() {
  const t = useT();
  const navigate = useNavigate();
  const [offer, setOffer] = useState<Offer | null>(null);
  const [busy, setBusy] = useState(false);
  const p = platform();
  const hasNode = !!p.node?.current();

  useEffect(() => {
    const links = platform().links;
    if (!links) return;
    // The link that waited for the node picker comes back once a node is chosen.
    const waiting = hasNode ? takePendingLink() : null;
    if (waiting) setOffer(offerOf(waiting));
    return links.subscribe((link) => {
      const next = offerOf(link);
      if (next) setOffer(next);
    });
  }, [hasNode]);

  if (!offer) return null;
  const { target, link } = offer;
  const node = target.node;
  const what =
    target.kind === "invite"
      ? t("deep_link.invite", { node })
      : target.kind === "room"
        ? t(target.channel ? "deep_link.channel" : "deep_link.room", { node })
        : t("deep_link.add", { node });
  const close = () => {
    setOffer(null);
    setBusy(false);
  };
  const open = async () => {
    if (!hasNode) {
      keepPendingLink(link);
      close();
      navigate(`/node?address=${encodeURIComponent(node)}`);
      return;
    }
    setBusy(true);
    const path = await deepLinkRoute(target, { web: webOrigin(), domain: platform().node?.domain?.() ?? null }, deepLinkDeps.identity).catch(() => null);
    close();
    if (path) navigate(path);
  };
  return (
    <Dialog title={t("deep_link.title")} open onClose={close}>
      <div className="space-y-3 text-sm text-fg-1" data-testid="deep-link-prompt" data-kind={target.kind}>
        <p>{t("deep_link.intro")}</p>
        <p className="font-medium text-fg-0" data-testid="deep-link-target">
          {what}
        </p>
        <dl className="rounded-md border border-line bg-bg-0 px-3 py-2">
          <dt className="text-xs text-fg-2">{t("deep_link.link")}</dt>
          <dd className="break-all font-mono text-xs text-fg-0" data-testid="deep-link-url">
            {stripBidi(link)}
          </dd>
        </dl>
        {!hasNode && <p data-testid="deep-link-no-node">{t("deep_link.no_node")}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={close} data-testid="deep-link-cancel">
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void open()} disabled={busy} data-testid="deep-link-open">
            {hasNode ? t("deep_link.open") : t("deep_link.choose_node")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
