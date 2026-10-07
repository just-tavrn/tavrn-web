// SPDX-License-Identifier: Apache-2.0
/** The per-conversation, device-local toggle "keep the full history on this device" (design note 4.4). */
import { qualify } from "@tavrn/e2ee";
import { useT } from "../i18n";
import { useE2ee } from "../stores/e2ee";
import { toastError, useToasts } from "../stores/toasts";
import { setKeepFullHistory, useLocalSearch } from "./local";
import { wakeSearchSync } from "./sync";

/**
 * `value`: the current setting, or null where it does not apply (plaintext conversations, voice channels,
 * a device that is locked or has no encryption). `toggle` switches it and starts the background sync.
 */
export function useFullHistory(domain: string, conversationId: string, applies: boolean): { value: boolean | null; toggle: () => void } {
  const t = useT();
  const q = qualify(domain, conversationId);
  const unlocked = useE2ee((s) => s.status === "unlocked");
  const ready = useLocalSearch((s) => s.ready);
  const complete = useLocalSearch((s) => !!s.coverage[q]?.complete);
  const value = applies && unlocked && ready ? complete : null;
  const toggle = () => {
    const next = !complete;
    void setKeepFullHistory(q, next)
      .then(() => {
        wakeSearchSync();
        useToasts.getState().push({ kind: "info", title: t(next ? "search.full_history_on" : "search.full_history_off") });
      })
      .catch(toastError);
  };
  return { value, toggle };
}
