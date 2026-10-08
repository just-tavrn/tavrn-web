// SPDX-License-Identifier: Apache-2.0
import { t } from "../i18n";
import type { Toast } from "../stores/toasts";
import type { Platform } from "./types";

/**
 * The start-up check of the desktop app: a newer signed release is announced with a link to Settings → App,
 * where the user installs it. Quiet without an updater, without an update and when the check fails (offline).
 */
export async function announceUpdate(p: Platform, toast: (t: Omit<Toast, "id">) => void): Promise<void> {
  if (!p.updater) return;
  const update = await p.updater.check().catch(() => null);
  if (update) toast({ kind: "info", title: t("desktop.update_available", { version: update.version }), path: "/settings/app", testId: "app-update-toast" });
}
