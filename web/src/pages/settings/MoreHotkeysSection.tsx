// SPDX-License-Identifier: Apache-2.0
/**
 * Settings → Voice: "More hotkeys" (issue #36): mute and deafen, next to the push-to-talk and priority keys of their
 * own sections. Every binding works in the window and, in the desktop app, system-wide (observed, never reserved).
 */
import { useT } from "../../i18n";
import { platform } from "../../platform";
import { useHotkeyState } from "../../voice/hotkeys";
import { HotkeyRecorder } from "./HotkeyRecorder";
import { Section } from "./common";

export function MoreHotkeysSection() {
  const t = useT();
  const desktop = !!platform().hotkeys;
  const listener = useHotkeyState((s) => s.listener);
  return (
    <Section title={t("voice.hotkeys.title")} description={desktop ? t("voice.hotkeys.description") : t("voice.hotkeys.description_browser")}>
      <div className="space-y-2" data-testid="more-hotkeys">
        {(["toggle_mute", "toggle_deafen", "whisper_reply"] as const).map((action) => (
          <div key={action} data-testid={`hotkey-${action}`}>
            <HotkeyRecorder action={action} label={t(`voice.hotkeys.action.${action}`)} testid={{ key: `hotkey-${action}-key`, change: `hotkey-${action}-change`, remove: `hotkey-${action}-remove` }} />
          </div>
        ))}
        {desktop && listener === "unavailable" && (
          <p className="text-xs text-warn" data-testid="hotkeys-unavailable">
            {t("voice.hotkeys.unavailable_note")}
          </p>
        )}
      </div>
    </Section>
  );
}
