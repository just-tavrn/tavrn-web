// SPDX-License-Identifier: Apache-2.0
/**
 * The quick menus of the microphone, headphones and camera buttons (voice bar and stage controls): right-click, the
 * context-menu key or a long press on touch opens them (`useContextMenu`); a click keeps muting, deafening or turning
 * the camera on and off. They stay open after a choice and close on a click outside, Escape or a second right-click on
 * the same button. The devices are listed only while a menu is open.
 */
import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { useT } from "../../i18n";
import { platform } from "../../platform";
import { ContextMenu, useContextMenu, type ContextMenuTrigger } from "../../components/ContextMenu";
import type { AnchorRect } from "../../lib/position";
import { outputSelectable, useMediaDevices } from "../devices";
import { cameraMenu, voiceDeviceMenu, type VoiceDeviceKind } from "../deviceMenu";
import { comboLabel } from "../hotkeys";
import { RangeSlider } from "./StreamAudio";
import { phoneCameras, useVoiceSettings } from "../settings";
import { devicePatch, deviceView, useNativeDevices, useNativeVoice } from "../nativeDevices";

/** The camera button's menu: front and back on phones, the camera list and "Settings…" on desktops. */
function CameraMenu({ anchor, trigger, onClose, beforeNavigate }: { anchor: AnchorRect; trigger: Element | null; onClose: () => void; beforeNavigate?: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const settings = useVoiceSettings((s) => s.settings);
  const save = useVoiceSettings((s) => s.update);
  const phone = phoneCameras();
  // A phone's menu names no device: nothing to list.
  const media = useMediaDevices({ source: phone ? null : undefined, autoUnlock: platform().isDesktop && !platform().android });
  const entries = cameraMenu(
    { devices: media.devices, settings, phone, needsPermission: media.needsPermission },
    {
      update: save,
      unlock: () => void media.unlock(),
      openSettings: () => {
        beforeNavigate?.();
        navigate("/settings/voice");
      },
    },
    t,
  );
  return <ContextMenu entries={entries} anchor={anchor} trigger={trigger} onClose={onClose} label={t("voice.menu.camera_label")} testId="voice-camera-menu" />;
}

function VoiceDeviceMenu({ kind, anchor, trigger, onClose, beforeNavigate }: { kind: VoiceDeviceKind; anchor: AnchorRect; trigger: Element | null; onClose: () => void; beforeNavigate?: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const stored = useVoiceSettings((s) => s.settings);
  const save = useVoiceSettings((s) => s.update);
  // The native engine lists its own devices (and always chooses the output); the browser's need the page's permission.
  const native = useNativeVoice();
  const nativeDevices = useNativeDevices(native);
  // The desktop app's window holds the microphone permission: the device names come without a prompt.
  const media = useMediaDevices({ source: native ? null : undefined, autoUnlock: platform().isDesktop && !platform().android });
  const settings = deviceView(stored, native);
  const ptt = settings.hotkeys.push_to_talk;
  const entries = voiceDeviceMenu(
    kind,
    { devices: native ? nativeDevices : media.devices, settings, needsPermission: !native && media.needsPermission, sinkSupported: native || outputSelectable(), pttKey: ptt ? comboLabel(ptt) : "" },
    {
      update: (patch) => save(devicePatch(patch, native)),
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
 * The quick menu of the microphone (`input`), headphones (`output`) or camera (`camera`) button: spread `triggerProps`
 * onto the button and render `overlay`. `beforeNavigate` runs before "Voice settings…" navigates (the voice bar closes
 * the drawer).
 */
export function useVoiceDeviceMenu(kind: VoiceDeviceKind | "camera", beforeNavigate?: () => void): { triggerProps: ContextMenuTrigger["triggerProps"]; overlay: ReactNode } {
  // Choices keep the menu open: a second right-click on the button closes it (as do Escape and a click outside).
  const menu = useContextMenu({ toggle: true });
  const open = menu.open && menu.anchor;
  const overlay = !open ? null : kind === "camera" ? (
    <CameraMenu anchor={menu.anchor!} trigger={menu.trigger} onClose={menu.close} beforeNavigate={beforeNavigate} />
  ) : (
    <VoiceDeviceMenu kind={kind} anchor={menu.anchor!} trigger={menu.trigger} onClose={menu.close} beforeNavigate={beforeNavigate} />
  );
  return { triggerProps: menu.triggerProps, overlay };
}
