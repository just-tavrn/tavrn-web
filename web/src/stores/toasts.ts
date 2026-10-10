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
}

interface ToastState {
  toasts: Toast[];
  push: (toast: Omit<Toast, "id">) => void;
  dismiss: (id: number) => void;
}

let counter = 0;

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (toast) => {
    const id = ++counter;
    set((s) => ({ toasts: [...s.toasts, { ...toast, id }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })), toast.kind === "error" || toast.action ? 8000 : 5000);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));

/** Error of an API call as a toast: known codes translated, otherwise the server's description. */
export function toastError(e: unknown, fallbackTitle?: string) {
  const err = e as { problem?: { code?: string; title?: string; detail?: string; request_id?: string }; message?: string };
  const title = fallbackTitle ?? err.problem?.title ?? t("common.error");
  const detail = errorMessage(err.problem?.code, err.problem?.detail || err.message);
  useToasts.getState().push({ kind: "error", title, detail: err.problem?.request_id ? `${detail} (${t("common.request", { id: err.problem.request_id })})` : detail });
}

/** Readable text for a caught error, e.g. in forms. */
export function describeError(e: unknown): string {
  const named = e as { name?: string; code?: string } | null;
  // Encryption flows (crypto/e2ee) and the browser's WebAuthn API.
  if (named?.name === "E2eeError" && named.code) return t(`e2ee.error.${named.code}`);
  if (named?.name === "MlsError" && (named.code === "catch_up_failed" || named.code === "ghost")) return t(`e2ee.mls_error.${named.code}`);
  if (named?.name === "NotAllowedError" || named?.name === "AbortError") return t("passkey.error.not_allowed");
  if (named?.name === "InvalidStateError") return t("passkey.error.exists");
  if (named?.name === "NotSupportedError" || named?.name === "SecurityError") return t("passkey.error.unsupported");
  const err = e as { problem?: { code?: string; detail?: string; title?: string }; message?: string };
  return errorMessage(err.problem?.code, err.problem?.detail || err.problem?.title || err.message);
}
