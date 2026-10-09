// SPDX-License-Identifier: Apache-2.0
/**
 * The date of birth (protocol PROTOCOL.md §5e): a native date input with a visible label, a hint that says what the
 * node does with it, and the error text linked by `aria-describedby` (WCAG 1.3.1, 3.3.1, 3.3.2).
 */
import { useId } from "react";
import { checkDateOfBirth } from "@tavrn/sdk";
import { useT } from "../../i18n";
import { todayIso } from "../../lib/age";

/** The translated problem with `value`, or null when the node will accept it. */
export function dateOfBirthError(value: string, minimumAge: number, t: (key: string, params?: Record<string, string | number>) => string, now: Date = new Date()): string | null {
  const problem = checkDateOfBirth(value, minimumAge, now);
  if (problem === "invalid") return t("age.dob.invalid");
  if (problem === "below_minimum") return t("age.dob.below_minimum", { age: minimumAge });
  return null;
}

export function DateOfBirthField({ value, onChange, error, disabled }: { value: string; onChange: (value: string) => void; error?: string | null; disabled?: boolean }) {
  const t = useT();
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <div className="space-y-1 text-sm">
      <label htmlFor={id} className="block text-fg-1">
        {t("age.dob.label")}
      </label>
      <input
        id={id}
        name="date_of_birth"
        type="date"
        autoComplete="bday"
        aria-required="true"
        min="1900-01-01"
        max={todayIso()}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={error ? `${hintId} ${errorId}` : hintId}
        aria-invalid={error ? true : undefined}
        data-testid="date-of-birth"
        className="min-h-10 w-full rounded-md border border-line-strong bg-bg-0 px-3 text-sm text-fg-0 outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-accent"
      />
      <span id={hintId} className="block text-xs text-fg-2">
        {t("age.dob.hint")}
      </span>
      {error && (
        <span id={errorId} role="alert" className="block text-xs text-danger" data-testid="date-of-birth-error">
          {error}
        </span>
      )}
    </div>
  );
}
