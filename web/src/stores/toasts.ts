// SPDX-License-Identifier: Apache-2.0
import { create } from "zustand";
import { errorMessage, t } from "../i18n";

export interface Toast {
  id: number;
  kind: "info" | "error" | "warning";
  title: string;
  detail?: string;
  /** A route the toast jumps to when clicked (notifications). */
  path?: string;
  testId?: string;
  /** A button next to the text (e.g. "show in folder" after a download); a click runs it and closes the toast. */
  action?: { label: string; run: () => void };
  /** Toasts with the same tag replace each other (notifications: one per conversation, the newest message). */
  tag?: string;
}

interface ToastState {
  toasts: Toast[];
  push: (toast: Omit<Toast, "id">) => void;
  dismiss: (id: number) => void;
}

/** Toasts shown at once; beyond that the oldest one goes (an informational one before warnings and errors). */
export const MAX_TOASTS = 5;

let counter = 0;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

/** `list` without the toasts beyond the cap: the oldest informational one first, else the oldest. */
function capped(list: Toast[]): Toast[] {
  let out = list;
  while (out.length > MAX_TOASTS) {
    const drop = out.find((x) => x.kind === "info") ?? out[0]!;
    out = out.filter((x) => x !== drop);
  }
  return out;
}

function forget(removed: Toast[]) {
  for (const x of removed) {
    clearTimeout(timers.get(x.id));
    timers.delete(x.id);
  }
}

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (toast) => {
    const id = ++counter;
    const before = get().toasts;
    const next = capped([...(toast.tag ? before.filter((x) => x.tag !== toast.tag) : before), { ...toast, id }]);
    forget(before.filter((x) => !next.includes(x)));
    set({ toasts: next });
    timers.set(
      id,
      setTimeout(() => get().dismiss(id), toast.kind === "error" || toast.action ? 8000 : 5000),
    );
  },
  dismiss: (id) => {
    clearTimeout(timers.get(id));
    timers.delete(id);
    if (get().toasts.some((x) => x.id === id)) set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }));
  },
}));

/**
 * Error of an API call (or any caught error) as a toast: the same readable text as in forms ({@link describeError}:
 * known codes, encryption, unlock and WebAuthn errors translated, otherwise the server's description), plus the
 * request id when the node sent one.
 */
export function toastError(e: unknown, fallbackTitle?: string) {
  const err = e as { problem?: { code?: string; title?: string; request_id?: string } } | null;
  // Refused by the role preview's write guard (lib/previewGuard.ts), which has shown its own toast.
  if (err?.problem?.code === "roleview.read_only") return;
  const title = fallbackTitle ?? err?.problem?.title ?? t("common.error");
  const text = describeError(e);
  // Without a detail of its own the problem's title is the text: shown once.
  const detail = text === title ? undefined : text;
  const id = err?.problem?.request_id;
  useToasts.getState().push({ kind: "error", title, detail: id ? `${detail ? `${detail} ` : ""}(${t("common.request", { id })})` : detail });
}

/** Readable text for a caught error, e.g. in forms. */
export function describeError(e: unknown): string {
  const named = e as { name?: string; code?: string } | null;
  // Encryption flows (crypto/e2ee) and the browser's WebAuthn API.
  if (named?.name === "E2eeError" && named.code) return t(`e2ee.error.${named.code}`);
  // The Android app's biometric unlock (platform/unlockError.ts).
  if (named?.name === "UnlockError" && named.code) return t(`unlock.error.${named.code}`);
  if (named?.name === "MlsError" && (named.code === "catch_up_failed" || named.code === "ghost")) return t(`e2ee.mls_error.${named.code}`);
  if (named?.name === "NotAllowedError" || named?.name === "AbortError") return t("passkey.error.not_allowed");
  if (named?.name === "InvalidStateError") return t("passkey.error.exists");
  if (named?.name === "NotSupportedError" || named?.name === "SecurityError") return t("passkey.error.unsupported");
  const err = e as { problem?: { code?: string; detail?: string; title?: string }; message?: string };
  return errorMessage(err.problem?.code, err.problem?.detail || err.problem?.title || err.message);
}
