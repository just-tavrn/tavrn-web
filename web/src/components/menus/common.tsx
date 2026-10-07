// SPDX-License-Identifier: Apache-2.0
import { useState, type ReactNode } from "react";
import { useT } from "../../i18n";
import { describeError, useToasts } from "../../stores/toasts";
import { copyText } from "../ContextMenu";
import { Button, Dialog, ErrorText, Field, Input } from "../ui";

/** Copies and confirms with a short toast. */
export async function copyWithToast(text: string, label: string) {
  const ok = await copyText(text);
  useToasts.getState().push(ok ? { kind: "info", title: label } : { kind: "warning", title: text });
}

/**
 * A confirmation dialog for menu actions, optionally with a reason field (ban, block). Errors stay in the
 * dialog.
 */
export function ConfirmAction({ title, text, action, danger = true, reasonLabel, onConfirm, onClose, testId }: { title: string; text: ReactNode; action: string; danger?: boolean; reasonLabel?: string; onConfirm: (reason: string) => Promise<void> | void; onClose: () => void; testId?: string }) {
  const t = useT();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog title={title} open onClose={onClose}>
      <form
        className="space-y-3 text-sm text-fg-1"
        data-testid={testId ?? "confirm-action"}
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await onConfirm(reason.trim());
            onClose();
          } catch (err) {
            setError(describeError(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div>{text}</div>
        {reasonLabel && (
          <Field label={reasonLabel}>
            <Input name="reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          </Field>
        )}
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant={danger ? "danger" : "primary"} disabled={busy}>
            {action}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
