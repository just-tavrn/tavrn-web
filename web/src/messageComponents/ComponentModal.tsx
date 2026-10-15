// SPDX-License-Identifier: Apache-2.0
/**
 * The form a bot asks for in answer to a button, a select or a command (tavrn-protocol/APPLICATIONS.md §5.10
 * "modal"): a real dialog (focus trap, Escape, labelled fields) with 1–5 text inputs, checked like the node checks
 * them before anything is sent. Closing discards it, after a confirmation once the user typed something.
 */
import { useId, useMemo, useState } from "react";
import { useT } from "../i18n";
import { describeError } from "../stores/toasts";
import { stripBidi } from "../lib/untrusted";
import { Button, Dialog, ErrorText } from "../components/ui";
import type { Modal, ModalInput } from "@tavrn/sdk";
import { BotBadge } from "../components/Badges";
import { confirmDialog } from "../components/Confirm";

const length = (v: string) => [...v].length;

/** The error key of one field, or null when the value passes `required`, `min_length` and `max_length`. */
export function inputError(input: ModalInput, value: string): { key: string; vars?: Record<string, number> } | null {
  const required = input.required ?? true;
  const n = length(value);
  if (n === 0 || !value.trim()) return required ? { key: "components.modal.required" } : null;
  const min = input.min_length ?? 0;
  const max = input.max_length ?? 4000;
  if (n < min) return { key: "components.modal.too_short", vars: { min } };
  if (n > max) return { key: "components.modal.too_long", vars: { max } };
  return null;
}

/** Error codes of the submit route the dialog explains in its own words (others: the general error text). */
const SUBMIT_ERRORS: Record<string, string> = {
  "interaction.expired": "components.modal.expired",
  "interaction.already_submitted": "components.modal.already_submitted",
  "interaction.values_invalid": "components.modal.values_invalid",
  "interaction.not_found": "components.modal.expired",
};

export function ComponentModal({ modal, appName, onSubmit, onClose }: { modal: Modal; appName: string; onSubmit: (values: Record<string, string>) => Promise<void>; onClose: () => void }) {
  const t = useT();
  const initial = useMemo(() => Object.fromEntries(modal.inputs.map((i) => [i.custom_id, i.value ?? ""])), [modal]);
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [shown, setShown] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [serverField, setServerField] = useState<string | null>(null);
  const formErrorId = useId();
  const baseId = useId();
  const dirty = modal.inputs.some((i) => values[i.custom_id] !== initial[i.custom_id]);
  const errors = Object.fromEntries(modal.inputs.map((i) => [i.custom_id, inputError(i, values[i.custom_id] ?? "")]));
  const close = async () => {
    if (pending) return;
    if (dirty && !done && !(await confirmDialog({ text: t("components.modal.discard"), confirmLabel: t("common.discard"), danger: true }))) return;
    onClose();
  };
  const submit = async () => {
    setShown(true);
    setServerField(null);
    if (Object.values(errors).some(Boolean)) {
      document.getElementById(`${baseId}-${modal.inputs.findIndex((i) => errors[i.custom_id])}`)?.focus();
      return;
    }
    setPending(true);
    setError(null);
    try {
      // Optional fields left empty are sent as empty strings: the bot sees every input of its form.
      await onSubmit(Object.fromEntries(modal.inputs.map((i) => [i.custom_id, values[i.custom_id] ?? ""])));
      setDone(true);
      onClose();
    } catch (e) {
      const problem = (e as { code?: string; problem?: { meta?: { path?: unknown } } }) ?? {};
      const key = problem.code ? SUBMIT_ERRORS[problem.code] : undefined;
      setError(key ? t(key) : describeError(e));
      // `meta.path` names the field the node refused (`values.<custom_id>`).
      const path = problem.problem?.meta?.path;
      if (typeof path === "string") setServerField(path.replace(/^values\.?/, "") || null);
      // Expired or answered: the form cannot be sent any more.
      if (problem.code === "interaction.expired" || problem.code === "interaction.already_submitted" || problem.code === "interaction.not_found") setDone(true);
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog title={stripBidi(modal.title)} open onClose={() => void close()}>
      <form
        noValidate
        className="space-y-3"
        data-testid="component-modal"
        data-custom-id={modal.custom_id}
        aria-describedby={error ? formErrorId : undefined}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="flex flex-wrap items-center gap-2 text-xs text-fg-2" data-testid="component-modal-app">
          <span>{t("components.modal.from", { name: appName })}</span>
          <BotBadge />
        </p>
        {modal.inputs.map((input, i) => {
          const id = `${baseId}-${i}`;
          const err = shown ? errors[input.custom_id] : null;
          const invalid = !!err || serverField === input.custom_id;
          const errId = `${id}-error`;
          const max = input.max_length ?? 4000;
          const common = {
            id,
            value: values[input.custom_id] ?? "",
            placeholder: input.placeholder ? stripBidi(input.placeholder) : undefined,
            required: input.required ?? true,
            "aria-invalid": invalid || undefined,
            "aria-describedby": err ? errId : undefined,
            disabled: pending || done,
            onChange: (e: { target: { value: string } }) => setValues((v) => ({ ...v, [input.custom_id]: e.target.value })),
            className: "w-full rounded-md border border-line-strong bg-bg-0 px-3 text-sm text-fg-0 outline-none placeholder:text-fg-2 focus:border-accent disabled:opacity-50 aria-invalid:border-danger",
            "data-testid": "component-modal-input",
            "data-custom-id": input.custom_id,
          };
          return (
            <div key={input.custom_id} className="space-y-1 text-sm">
              <label htmlFor={id} className="block text-fg-1">
                {stripBidi(input.label)}
                {(input.required ?? true) && (
                  <span className="text-danger" aria-hidden="true">
                    {" "}*
                  </span>
                )}
              </label>
              {input.style === "paragraph" ? <textarea {...common} rows={4} maxLength={max} className={`${common.className} min-h-24 py-2`} /> : <input {...common} type="text" maxLength={max} className={`${common.className} min-h-10`} />}
              <div className="flex gap-2 text-xs">
                {err ? (
                  <span id={errId} className="flex-1 text-danger" data-testid="component-modal-field-error">
                    {t(err.key, err.vars)}
                  </span>
                ) : (
                  <span className="flex-1" />
                )}
                <span className="text-fg-2" aria-hidden="true">
                  {length(values[input.custom_id] ?? "")}/{max}
                </span>
              </div>
            </div>
          );
        })}
        <ErrorText id={formErrorId}>{error}</ErrorText>
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={() => void close()} disabled={pending} data-testid="component-modal-cancel">
            {done ? t("common.close") : t("common.cancel")}
          </Button>
          <Button type="submit" disabled={pending || done} aria-busy={pending || undefined} data-testid="component-modal-submit">
            {pending ? t("components.modal.sending") : t("components.modal.submit")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
