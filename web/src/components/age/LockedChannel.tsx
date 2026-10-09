// SPDX-License-Identifier: Apache-2.0
/**
 * What a user below a channel's age gate sees instead of its content (protocol PROTOCOL.md §5e): a notice, no
 * messages, no composer, no previews, no voice.
 */
import { useT } from "../../i18n";

export function LockedChannel({ name }: { name: string }) {
  const t = useT();
  return (
    <section className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center" aria-labelledby="age-locked-title" data-testid="age-locked">
      <span aria-hidden="true" className="text-3xl">
        🔞
      </span>
      <h2 id="age-locked-title" className="text-base font-semibold text-fg-0">
        {t("age.locked.title")}
      </h2>
      <p className="max-w-md text-sm text-fg-1">{t("age.locked.text")}</p>
      <p className="text-xs text-fg-2">#{name}</p>
    </section>
  );
}

/** A small "18+" badge with an accessible name (no information by colour alone). */
export function AdultsOnlyBadge() {
  const t = useT();
  return (
    <span className="rounded border border-line px-1 text-[10px] font-semibold text-fg-1" title={t("age.badge_label")} aria-label={t("age.badge_label")} role="img">
      {t("age.badge")}
    </span>
  );
}
