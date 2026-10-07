// SPDX-License-Identifier: Apache-2.0
/**
 * Device-local accessibility settings (design note 4.14 item 4, `stores/accessibility.ts`): whether screen readers
 * announce new messages of the open conversation.
 */
import { useT } from "../../i18n";
import { useAccessibility } from "../../stores/accessibility";
import { Section } from "./common";

export function AccessibilitySection() {
  const t = useT();
  const announce = useAccessibility((s) => s.announceMessages);
  const set = useAccessibility((s) => s.set);
  return (
    <Section title={t("a11y.settings_title")} description={t("a11y.settings_hint")}>
      <label className="flex min-h-10 items-center gap-2 text-sm">
        <input type="checkbox" className="h-4 w-4 accent-accent" checked={announce} onChange={(e) => set({ announceMessages: e.target.checked })} data-testid="announce-messages" />
        {t("a11y.announce_messages")}
      </label>
    </Section>
  );
}
