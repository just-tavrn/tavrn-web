// SPDX-License-Identifier: Apache-2.0
import { Permission, hasPermission } from "@tavrn/sdk";
import { useT } from "../../i18n";
import { useVoice } from "../store";
import { setPrioritySpeaker } from "../index";
import { MegaphoneIcon } from "./icons";

/**
 * Priority speaker toggle of the control bar (design note 4.13 item 3): only with `priority_speaker` in the
 * channel. On phones and tablets (no key to hold) it is the way to talk over others; on desktops the key
 * from the voice settings does the same while held.
 */
export function PriorityButton({ perms }: { perms: bigint }) {
  const t = useT();
  const active = useVoice((s) => s.prioritySelf);
  const canSpeak = useVoice((s) => s.canSpeak);
  if (!hasPermission(perms, Permission.PRIORITY_SPEAKER) || !canSpeak) return null;
  const label = active ? t("voice.priority.off") : t("voice.priority.on");
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      data-testid="voice-priority"
      onClick={() => setPrioritySpeaker(!active)}
      className={`inline-flex min-h-11 min-w-11 items-center justify-center rounded-md ${active ? "bg-accent text-accent-text" : "text-fg-1 hover:bg-bg-3 hover:text-fg-0"}`}
    >
      <MegaphoneIcon size={20} />
    </button>
  );
}
