// SPDX-License-Identifier: Apache-2.0
/**
 * The recorder of one hotkey action (issue #36): the binding as the keyboard shows it, "Change", then press a key, a
 * modifier alone or a combination; Escape cancels, Backspace removes the binding. While the action is held (in the
 * window or system-wide) the key lights up, which also tests the binding.
 */
import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import type { HotkeyAction } from "../../platform";
import { Button, ErrorText } from "../../components/ui";
import { useVoiceSettings } from "../../voice/settings";
import { bindHotkey, clearHotkey, comboLabel, keyOs, setRecording, useHotkeyState } from "../../voice/hotkeys";
import { ComboRecorder } from "../../voice/hotkeyRecorder";

const SUPER_NAMES = { linux: "Super", windows: "Win", mac: "Cmd" } as const;

export function HotkeyRecorder({ action, label, testid, removable = true }: { action: HotkeyAction; label: string; testid: { key: string; change: string; remove?: string }; removable?: boolean }) {
  const t = useT();
  const bound = useVoiceSettings((s) => s.settings.hotkeys[action]);
  const held = useHotkeyState((s) => !!s.held[action]);
  const [recording, setActive] = useState(false);
  const [partial, setPartial] = useState("");
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<ComboRecorder | null>(null);

  useEffect(() => {
    if (!recording) return;
    recorder.current = new ComboRecorder();
    setRecording(true);
    // React removes the listeners a moment after the recording ends: keys pressed meanwhile act as bindings again.
    let done = false;
    const finish = () => {
      done = true;
      setRecording(false);
      setActive(false);
      setPartial("");
    };
    const handle = (e: KeyboardEvent, down: boolean) => {
      if (done) return;
      e.preventDefault();
      e.stopPropagation();
      const step = down ? recorder.current?.down(e) : recorder.current?.up(e);
      if (!step) return;
      if (step.kind === "partial") return setPartial(step.held);
      finish();
      if (step.kind === "clear") void clearHotkey(action).catch(() => undefined);
      if (step.kind === "done") void bindHotkey(action, step.combo).then(setError);
    };
    const onDown = (e: KeyboardEvent) => handle(e, true);
    const onUp = (e: KeyboardEvent) => handle(e, false);
    window.addEventListener("keydown", onDown, { capture: true });
    window.addEventListener("keyup", onUp, { capture: true });
    return () => {
      window.removeEventListener("keydown", onDown, { capture: true });
      window.removeEventListener("keyup", onUp, { capture: true });
      setRecording(false);
    };
  }, [recording, action]);

  const shown = recording ? (partial ? comboLabel(`${partial}…`) : t("voice.hotkeys.recording")) : bound ? comboLabel(bound) : t("voice.hotkeys.none");
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="min-w-0 flex-1 basis-40 text-fg-1">{label}</span>
        <kbd
          className={`rounded border px-2 py-1 font-mono text-xs ${recording ? "border-accent bg-bg-0" : held ? "border-accent bg-accent/20 text-fg-0" : "border-line bg-bg-0"}`}
          data-testid={testid.key}
          data-held={held || undefined}
          title={held ? t("voice.hotkeys.held") : undefined}
          aria-live="polite"
        >
          {shown}
        </kbd>
        <Button
          variant="ghost"
          aria-pressed={recording}
          onClick={() => {
            setError(null);
            setPartial("");
            setActive((r) => !r);
          }}
          data-testid={testid.change}
        >
          {recording ? t("voice.hotkeys.recording") : t("voice.hotkeys.change")}
        </Button>
        {removable && bound && !recording && testid.remove && (
          <Button variant="ghost" onClick={() => void clearHotkey(action).catch(() => undefined)} data-testid={testid.remove}>
            {t("voice.hotkeys.remove")}
          </Button>
        )}
      </div>
      {recording && <p className="text-xs text-fg-2">{t("voice.hotkeys.recording_hint", { super: SUPER_NAMES[keyOs()] })}</p>}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
