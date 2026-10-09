// SPDX-License-Identifier: Apache-2.0
/**
 * The age gate of a room or a channel (protocol PROTOCOL.md §5e): "Everyone" or "Adults only (18+)", applied at once.
 * The room's gate is every channel's minimum; only adults can switch a gate on (the node refuses otherwise).
 */
import { useState } from "react";
import { useT } from "../../i18n";
import { toastError, useToasts } from "../../stores/toasts";
import { Section, Select } from "../../pages/settings/common";
import { Field } from "../ui";

export function AgeGateSection({ scope, value, inherited, canManage, onSave }: { scope: "room" | "channel"; value: string; inherited?: boolean; canManage: boolean; onSave: (gate: "none" | "adults_only") => Promise<unknown> }) {
  const t = useT();
  const [gate, setGate] = useState(value === "adults_only" ? "adults_only" : "none");
  const [busy, setBusy] = useState(false);
  const change = async (next: "none" | "adults_only") => {
    const before = gate;
    setGate(next);
    setBusy(true);
    try {
      await onSave(next);
      useToasts.getState().push({ kind: "info", title: t("age.gate.saved") });
    } catch (err) {
      setGate(before);
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title={t("age.gate.label")} description={t(scope === "room" ? "age.gate.room_hint" : "age.gate.channel_hint")}>
      <Field label={t("age.gate.label")} hint={inherited ? t("age.gate.room_inherited") : undefined}>
        <Select value={gate} disabled={!canManage || busy} onChange={(e) => void change(e.target.value === "adults_only" ? "adults_only" : "none")} data-testid={`${scope}-age-gate`}>
          <option value="none">{t("age.gate.none")}</option>
          <option value="adults_only">{t("age.gate.adults_only")}</option>
        </Select>
      </Field>
    </Section>
  );
}
