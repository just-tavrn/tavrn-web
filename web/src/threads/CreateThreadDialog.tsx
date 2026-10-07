// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";
import { THREAD_TITLE_MAX } from "@tavrn/e2ee";
import { useT } from "../i18n";
import { Button, Dialog, ErrorText, Field, Input } from "../components/ui";
import { describeError } from "../stores/toasts";

/** "Create thread": asks for the title (prefilled from the message) and starts the thread. */
export function CreateThreadDialog({ open, initialTitle, encrypted, onClose, onCreate }: { open: boolean; initialTitle: string; encrypted: boolean; onClose: () => void; onCreate: (title: string) => Promise<void> }) {
  const t = useT();
  const [title, setTitle] = useState(initialTitle);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setTitle(initialTitle);
      setError(null);
    }
  }, [open, initialTitle]);
  const valid = title.trim().length > 0 && Array.from(title.trim()).length <= THREAD_TITLE_MAX;
  return (
    <Dialog title={t("threads.create_title")} open={open} onClose={onClose}>
      <form
        className="space-y-4"
        data-testid="create-thread-dialog"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!valid || busy) return;
          setBusy(true);
          setError(null);
          try {
            await onCreate(title.trim());
          } catch (err) {
            setError(describeError(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label={t("threads.title")} hint={encrypted ? t("threads.title_encrypted_hint") : t("threads.title_plain_hint")}>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={THREAD_TITLE_MAX} required data-testid="thread-title-input" />
        </Field>
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={!valid || busy} data-testid="create-thread-submit">
            {t("threads.create")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
