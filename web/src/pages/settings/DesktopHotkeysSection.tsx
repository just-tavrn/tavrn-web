// SPDX-License-Identifier: Apache-2.0
/**
 * Settings → Voice: the global hotkeys of the desktop app (docs/DESKTOP.md "Global hotkeys"). One recorder per action:
 * "Change", then press the combination; Escape cancels, Backspace removes the binding. The browser shows only a hint.
 */
import { useEffect, useState } from "react";
import { useT } from "../../i18n";
import { platform, type HotkeyAction } from "../../platform";
import { Button, ErrorText } from "../../components/ui";
import { useVoiceSettings } from "../../voice/settings";
import { HOTKEY_ACTIONS, bindHotkey, clearHotkey, comboFromEvent, comboLabel, heldModifiers } from "../../voice/hotkeys";
import { Section } from "./common";

export function DesktopHotkeysSection() {
  const t = useT();
  const bindings = useVoiceSettings((s) => s.settings.desktopHotkeys);
  const inputMode = useVoiceSettings((s) => s.settings.inputMode);
  const [recording, setRecording] = useState<HotkeyAction | null>(null);
  const [partial, setPartial] = useState("");
  const [error, setError] = useState<string | null>(null);
  const desktop = !!platform().hotkeys;

  useEffect(() => {
    if (!recording) return;
    const finish = () => {
      setRecording(null);
      setPartial("");
    };
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const plain = !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey;
      if (plain && e.code === "Escape") return finish();
      if (plain && e.code === "Backspace") {
        finish();
        void clearHotkey(recording).catch(() => undefined);
        return;
      }
      const combo = comboFromEvent(e);
      if (!combo) {
        setPartial(heldModifiers(e));
        return;
      }
      finish();
      void bindHotkey(recording, combo).then(setError);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [recording]);

  if (!desktop) {
    return (
      <Section title={t("voice.hotkeys.title")}>
        <p className="text-xs text-fg-2" data-testid="desktop-hotkeys-hint">
          {t("voice.hotkeys.browser_hint")}
        </p>
      </Section>
    );
  }

  return (
    <Section title={t("voice.hotkeys.title")} description={t("voice.hotkeys.description")}>
      <div className="space-y-3" data-testid="desktop-hotkeys">
        <ul className="space-y-2">
          {HOTKEY_ACTIONS.map((action) => {
            const active = recording === action;
            const bound = bindings[action];
            const shown = active ? (partial ? comboLabel(`${partial}…`) : t("voice.hotkeys.recording")) : bound ? comboLabel(bound) : t("voice.hotkeys.none");
            return (
              <li key={action} className="flex flex-wrap items-center gap-2 text-sm" data-testid={`hotkey-${action}`}>
                <span className="min-w-0 flex-1 basis-48 text-fg-1">{t(`voice.hotkeys.action.${action}`)}</span>
                <kbd className={`rounded border bg-bg-0 px-2 py-1 font-mono text-xs ${active ? "border-accent" : "border-line"}`} data-testid={`hotkey-${action}-key`} aria-live="polite">
                  {shown}
                </kbd>
                <Button
                  variant="ghost"
                  aria-pressed={active}
                  onClick={() => {
                    setError(null);
                    setPartial("");
                    setRecording(active ? null : action);
                  }}
                  data-testid={`hotkey-${action}-change`}
                >
                  {active ? t("voice.hotkeys.recording") : t("voice.hotkeys.change")}
                </Button>
                {bound && !active && (
                  <Button variant="ghost" onClick={() => void clearHotkey(action).catch(() => undefined)} data-testid={`hotkey-${action}-remove`}>
                    {t("voice.hotkeys.remove")}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
        {recording && <p className="text-xs text-fg-2">{t("voice.hotkeys.recording_hint")}</p>}
        {bindings.push_to_talk && inputMode !== "ptt" && (
          <p className="text-xs text-fg-2" data-testid="hotkey-ptt-mode">
            {t("voice.hotkeys.ptt_mode_hint")}
          </p>
        )}
        <ErrorText>{error}</ErrorText>
      </div>
    </Section>
  );
}
