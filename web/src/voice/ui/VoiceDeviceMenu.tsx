// SPDX-License-Identifier: Apache-2.0
/**
 * The quick menus of the microphone and headphones buttons (voice bar and stage controls): right-click, the
 * context-menu key or a long press on touch opens them (`useContextMenu`); a click keeps muting or deafening. They
 * stay open after a choice and close on a click outside, Escape or a second right-click on the same button.
 * The devices are listed only while a menu is open.
 */
import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { useT } from "../../i18n";
import { platform } from "../../platform";
import { ContextMenu, useContextMenu, type ContextMenuTrigger } from "../../components/ContextMenu";
import type { AnchorRect } from "../../lib/position";
import { outputSelectable, useMediaDevices } from "../devices";
import { voiceDeviceMenu, type VoiceDeviceKind } from "../deviceMenu";
import { comboLabel } from "../hotkeys";
import { RangeSlider } from "./StreamAudio";
import { useVoiceSettings } from "../settings";

function VoiceDeviceMenu({ kind, anchor, trigger, onClose, beforeNavigate }: { kind: VoiceDeviceKind; anchor: AnchorRect; trigger: Element | null; onClose: () => void; beforeNavigate?: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const settings = useVoiceSettings((s) => s.settings);
  const update = useVoiceSettings((s) => s.update);
  // The desktop app's window holds the microphone permission: the device names come without a prompt.
  const media = useMediaDevices({ autoUnlock: platform().isDesktop });
  const ptt = settings.hotkeys.push_to_talk;
  const entries = voiceDeviceMenu(
    kind,
    { devices: media.devices, settings, needsPermission: media.needsPermission, sinkSupported: outputSelectable(), pttKey: ptt ? comboLabel(ptt) : "" },
    {
      update,
      unlock: () => void media.unlock(),
      slider: (spec) => ({ kind: "custom", id: spec.id, render: () => <RangeSlider label={spec.label} value={spec.value} min={spec.min} max={spec.max} step={spec.step} unit={spec.unit} onChange={spec.onChange} testid={`voice-menu-${spec.id}`} /> }),
      openSettings: () => {
        beforeNavigate?.();
        navigate("/settings/voice");
      },
    },
    t,
  );
  return <ContextMenu entries={entries} anchor={anchor} trigger={trigger} onClose={onClose} label={t(kind === "input" ? "voice.menu.input_label" : "voice.menu.output_label")} testId={`voice-${kind}-menu`} />;
}

/**
 * The quick menu of the microphone (`input`) or headphones (`output`) button: spread `triggerProps` onto the button
 * and render `overlay`. `beforeNavigate` runs before "Voice settings…" navigates (the voice bar closes the drawer).
 */
export function useVoiceDeviceMenu(kind: VoiceDeviceKind, beforeNavigate?: () => void): { triggerProps: ContextMenuTrigger["triggerProps"]; overlay: ReactNode } {
  // Choices keep the menu open: a second right-click on the button closes it (as do Escape and a click outside).
  const menu = useContextMenu({ toggle: true });
  const overlay = menu.open && menu.anchor ? <VoiceDeviceMenu kind={kind} anchor={menu.anchor} trigger={menu.trigger} onClose={menu.close} beforeNavigate={beforeNavigate} /> : null;
  return { triggerProps: menu.triggerProps, overlay };
}
