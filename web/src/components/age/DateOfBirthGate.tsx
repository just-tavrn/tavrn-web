// SPDX-License-Identifier: Apache-2.0
/**
 * Accounts without a date of birth (created before `age.v1`, or by single sign-on) complete it before anything else
 * works: the node answers `403 age.status_required` everywhere but the own account (protocol PROTOCOL.md §5e). This
 * blocking dialog asks once; signing out is the only other way.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useT } from "../../i18n";
import { api } from "../../lib/api";
import { useMe } from "../../lib/age";
import { signOut } from "../../stores/e2ee";
import { describeError } from "../../stores/toasts";
import { Button, Dialog, ErrorText } from "../ui";
import { DateOfBirthField, dateOfBirthError } from "./DateOfBirthField";
import { nodeInfoQuery } from "../../lib/queries";

export function DateOfBirthGate() {
  const t = useT();
  const me = useMe();
  const queryClient = useQueryClient();
  const node = useQuery({ ...nodeInfoQuery(null), enabled: me.data?.age_status?.tier === "unknown" });
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (me.data?.age_status?.tier !== "unknown") return null;
  const minimum = node.data?.age?.minimum_age ?? 16;
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const problem = dateOfBirthError(value, minimum, t);
    setFieldError(problem);
    if (problem) return;
    setBusy(true);
    try {
      const updated = await api.users.setDateOfBirth(value);
      queryClient.setQueryData(["me"], updated);
      // Everything the node refused meanwhile loads again.
      await queryClient.invalidateQueries();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={t("age.dialog.title")} open onClose={() => undefined}>
      <form className="space-y-3 text-sm" onSubmit={(e) => void save(e)} data-testid="dob-dialog" noValidate>
        <p className="text-fg-1">{t("age.dialog.text")}</p>
        <DateOfBirthField value={value} onChange={setValue} error={fieldError} disabled={busy} />
        <p className="text-xs text-fg-2">{t("age.dialog.once")}</p>
        <ErrorText>{error}</ErrorText>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={() => void signOut().catch(() => undefined)} data-testid="dob-sign-out">
            {t("age.dialog.sign_out")}
          </Button>
          <Button type="submit" disabled={busy} data-testid="dob-save">
            {t("age.dialog.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
