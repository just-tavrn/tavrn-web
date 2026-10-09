// SPDX-License-Identifier: Apache-2.0
/**
 * Moderation events (protocol MODERATION.md §1.5, §2.4): `report.create` refreshes the inbox and notifies through
 * the normal notification path (notification center and toast; while no tab is open the node sends a web push of type
 * `report` instead, `public/sw.js`), `moderation.alert` describes what auto-moderation did.
 */
import type { QueryClient } from "@tanstack/react-query";
import { t as translate } from "../i18n";
import { roomPath } from "../components/NodeScope";
import { isMuted } from "../lib/menus";
import { useNotifications } from "../stores/notifications";
import { useToasts } from "../stores/toasts";

type T = (key: string, params?: Record<string, string | number>) => string;

export interface ReportCreated {
  report: { id: string; scope: string; source?: string; kind?: string; room_id?: string | null; room_name?: string | null; category?: string };
}

export interface ModerationAlert {
  room_id?: string | null;
  user: { display_name: string };
  kind?: string;
  deleted?: number;
  rule?: string;
  scope?: string;
  matched?: string;
  action?: string;
}

/** The toast text of a `moderation.alert`. */
export function alertText(d: ModerationAlert, t: T = translate): string {
  if (d.kind === "content") {
    const rule = d.scope === "node" ? t("automod.node_rule") : (d.rule ?? "");
    return t("automod.content_alert", { name: d.user.display_name, rule, matched: d.matched ?? "", action: t(`automod.action.${d.action ?? "block"}`) });
  }
  return t("automod.spam", { name: d.user.display_name, count: d.deleted ?? 0 });
}

/** Where a new report is handled: the room's Reports tab or Admin → Reports. */
export function reportPath(r: ReportCreated["report"], node: string | null): string {
  return r.scope === "room" && r.room_id ? roomPath(node, r.room_id, undefined, "settings/reports") : "/admin/reports";
}

/** `report.create` on the socket of `node` (null = home node). */
export function reportCreated(d: ReportCreated, node: string | null, queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: ["reports"] });
  const settings = useNotifications.getState().settings;
  if (settings.global.mode === "nothing") return;
  if (d.report.room_id && isMuted(settings.rooms[d.report.room_id]?.muted_until)) return;
  const title = translate("reports.notify_title");
  const body = d.report.room_name ? translate("reports.notify_room", { room: d.report.room_name }) : translate("reports.notify_node");
  const path = reportPath(d.report, node);
  useNotifications.getState().push({ kind: "report", title, body, path });
  useToasts.getState().push({ kind: "info", title, detail: body, path, testId: "report-toast" });
}
