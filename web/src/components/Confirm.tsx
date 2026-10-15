// SPDX-License-Identifier: Apache-2.0
/**
 * In-app confirmation instead of the browser's `window.confirm`, which blocks the page (realtime events, encryption
 * and voice updates stall while it is open), cannot be styled or translated and depends on the shell's dialog
 * handler in the desktop and Android apps. `confirmDialog()` resolves `true` or `false`; {@link ConfirmHost}, mounted
 * once by the app, shows the pending question as a modal {@link Dialog}. Cancel comes first and takes the focus, so
 * Enter never confirms by accident; Escape and a click on the backdrop cancel.
 */
import { useEffect, type ReactNode } from "react";
import { create } from "zustand";
import { useT } from "../i18n";
import { Button, Dialog } from "./ui";

export interface ConfirmRequest {
  /** The dialog's heading (default: "Are you sure?"). */
  title?: string;
  /** The question. */
  text: ReactNode;
  /** The confirming button (default: "Confirm"). */
  confirmLabel?: string;
  /** Destructive or irreversible: the confirming button is red. */
  danger?: boolean;
}

interface Pending extends ConfirmRequest {
  resolve: (yes: boolean) => void;
}

const useConfirm = create<{ pending: Pending | null; hosts: number }>(() => ({ pending: null, hosts: 0 }));

/**
 * Asks `req` in the app's confirmation dialog. A newer question cancels an unanswered one; without a mounted
 * {@link ConfirmHost} nothing is confirmed (`false`), so an action never runs unasked.
 */
export function confirmDialog(req: ConfirmRequest): Promise<boolean> {
  const state = useConfirm.getState();
  if (state.hosts === 0) {
    console.error("confirmDialog: no ConfirmHost is mounted");
    return Promise.resolve(false);
  }
  state.pending?.resolve(false);
  return new Promise((resolve) => useConfirm.setState({ pending: { ...req, resolve } }));
}

function answer(yes: boolean) {
  const pending = useConfirm.getState().pending;
  useConfirm.setState({ pending: null });
  pending?.resolve(yes);
}

/** The dialog of {@link confirmDialog}; the app mounts it once (tests mount it next to the view under test). */
export function ConfirmHost() {
  const t = useT();
  const pending = useConfirm((s) => s.pending);
  useEffect(() => {
    useConfirm.setState((s) => ({ hosts: s.hosts + 1 }));
    return () => {
      useConfirm.setState((s) => ({ hosts: s.hosts - 1 }));
      if (useConfirm.getState().hosts === 0) answer(false);
    };
  }, []);
  return (
    <Dialog title={pending?.title ?? t("common.confirm_title")} open={!!pending} onClose={() => answer(false)}>
      {pending && (
        <div className="space-y-4 text-sm text-fg-1" data-testid="confirm-dialog">
          <div className="whitespace-pre-line break-words" data-testid="confirm-text">
            {pending.text}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => answer(false)} data-testid="confirm-cancel">
              {t("common.cancel")}
            </Button>
            <Button variant={pending.danger ? "danger" : "primary"} onClick={() => answer(true)} data-testid="confirm-ok">
              {pending.confirmLabel ?? t("common.confirm")}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
