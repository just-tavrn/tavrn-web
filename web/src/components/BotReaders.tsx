// SPDX-License-Identifier: Apache-2.0
import { useMemo } from "react";
import type { Member } from "@tavrn/sdk";
import { splitIdentity, type MlsManager } from "@tavrn/e2ee";
import { useT } from "../i18n";
import { BotIcon } from "./icons";

/**
 * Next to the lock of an encrypted channel's header: the bots whose leaves are in the channel's encryption group right
 * now (APPLICATIONS.md §3.6), read from this device's own copy of the roster, so the node cannot hide one. A robot head
 * with the count; the names are in the accessible name and the tooltip. Nothing while no bot reads along.
 */
export function BotReaders({ mls, conversation, tick, bots, members }: { mls: MlsManager | null; conversation: string; tick: number; bots?: ReadonlySet<string>; members?: Member[] }) {
  const t = useT();
  const readers = useMemo(() => {
    if (!mls || !bots?.size) return [];
    const inGroup = new Set(mls.roster(conversation).map((identity) => splitIdentity(identity).address));
    return [...inGroup].filter((address) => bots.has(address)).sort();
    // `tick` moves with every epoch change of the group: the roster is read again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mls, conversation, tick, bots]);
  if (readers.length === 0) return null;
  const names = readers.map((address) => members?.find((m) => m.user.address === address)?.user.display_name || address.split("@")[0] || address);
  const label = t("e2ee.bot_readers", { names: names.join(", ") });
  return (
    <span role="img" aria-label={label} title={label} className="inline-flex shrink-0 cursor-help items-center gap-0.5 text-xs font-medium text-fg-1" data-testid="bot-readers" data-count={readers.length}>
      <BotIcon size={16} />
      <span aria-hidden="true">{readers.length}</span>
    </span>
  );
}
