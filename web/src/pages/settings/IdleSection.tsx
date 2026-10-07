// SPDX-License-Identifier: Apache-2.0
/**
 * Automatic "idle" status (design note 4.9, 4.13 item 3): after how many minutes without input (keys, pointer,
 * touch, or talking in a voice channel) this device shows the user as idle. Kept per device.
 */
import { useT } from "../../i18n";
import { Field } from "../../components/ui";
import { IDLE_CHOICES, normalizeIdleMinutes, useIdleSettings } from "../../lib/idle";
import { Section, Select } from "./common";

export function IdleSection() {
  const t = useT();
  const minutes = useIdleSettings((s) => s.minutes);
  const setMinutes = useIdleSettings((s) => s.setMinutes);
  return (
    <Section title={t("user.idle.title")} description={t("user.idle.hint")}>
      <Field label={t("user.idle.after")}>
        <Select value={String(minutes)} onChange={(e) => setMinutes(normalizeIdleMinutes(e.target.value))} data-testid="idle-timeout">
          {IDLE_CHOICES.map((m) => (
            <option key={m} value={String(m)}>
              {m === 0 ? t("user.idle.never") : t("user.idle.minutes", { count: m })}
            </option>
          ))}
        </Select>
      </Field>
    </Section>
  );
}
