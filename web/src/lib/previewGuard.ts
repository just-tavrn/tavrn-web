// SPDX-License-Identifier: Apache-2.0
/**
 * The read-only guarantee of the role preview (docs/CLIENT.md "View the room as a role"): while a preview is active,
 * every request that would change something on a node is refused on this device before it leaves, with one
 * explanatory toast, so no action runs with the viewer's real permissions by accident. Exempt is only the device's own
 * background upkeep that is no action in the room (session refresh and federated sessions, presence, MLS and key
 * upkeep, history keys for others, the account's conversation index and backups); read markers are refused silently
 * (the viewer reads nothing as the role).
 */
import { TavrnApiError } from "@tavrn/sdk";
import { t } from "../i18n";
import { previewing } from "../stores/rolePreview";
import { useToasts } from "../stores/toasts";

/** The error code of a refused request (also what `toastError` skips: the guard has said it already). */
export const PREVIEW_REFUSED = "roleview.read_only";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Paths (below `/api/v1`) of the device's background upkeep: never actions in the previewed room. */
const EXEMPT: readonly RegExp[] = [
  /^\/auth\/(refresh|logout|federated)$/,
  /^\/federation\/token$/,
  // The account's presence (idle detection, game activity): no action in the room.
  /^\/users\/me\/(presence|activity)$/,
  /^\/users\/me\/devices\/[^/]+\/(key|share-key|key-packages)$/,
  /^\/users\/[^/]+\/key-packages\/claim$/,
  /^\/conversations\/[^/]+\/mls\//,
  /^\/mls\//,
  /^\/conversations\/[^/]+\/(inbox-key|history-keys)(\/|$)/,
  /^\/users\/me\/conversations-index$/,
  /^\/users\/me\/backups\//,
];

/** Refused without a toast: read markers (opening a channel in the preview must not mark it read). */
const SILENT: readonly RegExp[] = [/^\/conversations\/[^/]+\/read$/, /^\/threads\/[^/]+\/read$/];

function apiPath(url: string): string {
  let path: string;
  try {
    path = new URL(url, "http://localhost").pathname;
  } catch {
    path = url;
  }
  const i = path.indexOf("/api/v1/");
  return i >= 0 ? path.slice(i + "/api/v1".length) : path;
}

/** What the guard does with a request while a preview is active. */
export function previewDecision(method: string, url: string): "allow" | "refuse" | "silent" {
  if (READ_METHODS.has(method.toUpperCase())) return "allow";
  const path = apiPath(url);
  if (EXEMPT.some((re) => re.test(path))) return "allow";
  return SILENT.some((re) => re.test(path)) ? "silent" : "refuse";
}

let lastToast = 0;

/** The explanatory toast (at most one per two seconds: one click can start several requests). */
export function toastPreviewRefused(): void {
  const now = Date.now();
  if (now - lastToast < 2000) return;
  lastToast = now;
  useToasts.getState().push({ kind: "warning", title: t("roleview.refused_title"), detail: t("roleview.refused_detail"), testId: "preview-refused" });
}

function refusal() {
  return { type: "about:blank", title: t("roleview.refused_title"), status: 403, detail: t("roleview.refused_detail"), code: PREVIEW_REFUSED };
}

export function previewRefusedError(): TavrnApiError {
  return new TavrnApiError(refusal());
}

/**
 * For actions that do work on this device before their request (encrypting a message, joining voice): throws the
 * refusal (after the toast) while a preview is active.
 */
export function assertNotPreviewing(): void {
  if (!previewing()) return;
  toastPreviewRefused();
  throw previewRefusedError();
}

/**
 * The guard in front of a node client's `fetch` (`trackingFetch` applies it to every node client): `null` lets the
 * request through, otherwise the answer it gets instead, a 403 problem with the code {@link PREVIEW_REFUSED}, so the
 * SDK raises it as a `TavrnApiError` like any refusal and nothing reaches the node.
 */
export function previewGuard(input: RequestInfo | URL, init?: RequestInit): Response | null {
  if (!previewing()) return null;
  const method = init?.method ?? (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET");
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const decision = previewDecision(method, url);
  if (decision === "allow") return null;
  if (decision === "refuse") toastPreviewRefused();
  return new Response(JSON.stringify(refusal()), { status: 403, headers: { "Content-Type": "application/problem+json" } });
}
