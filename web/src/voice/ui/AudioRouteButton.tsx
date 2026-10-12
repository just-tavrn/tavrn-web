// SPDX-License-Identifier: Apache-2.0
/**
 * The audio output switch of the Android app's voice controls (docs/ANDROID.md "Audio output"): the button names and
 * shows the route in use (speaker, earpiece, a wired or a Bluetooth headset), a tap opens the menu of the connected
 * outputs. Nothing outside the Android app: browsers and the desktop choose the output device in the headphones menu.
 */
import { useEffect, useState } from "react";
import { useT } from "../../i18n";
import { platform } from "../../platform";
import type { AudioRoute, AudioRoutes, PlatformAndroid } from "../../platform/types";
import { ContextMenu, useContextMenu } from "../../components/ContextMenu";
import { useToasts } from "../../stores/toasts";
import { audioRouteMenu, routeLabel } from "../audioRoutes";
import { BluetoothIcon, HeadphonesIcon, PhoneIcon, SpeakerIcon } from "./icons";

const ICONS: Record<AudioRoute, typeof SpeakerIcon> = { speaker: SpeakerIcon, earpiece: PhoneIcon, bluetooth: BluetoothIcon, wired: HeadphonesIcon };

function RouteButton({ android, className }: { android: PlatformAndroid; className: string }) {
  const t = useT();
  const [routes, setRoutes] = useState<AudioRoutes | null>(null);
  const menu = useContextMenu();
  useEffect(() => {
    let live = true;
    android.audio
      .routes()
      .then((r) => live && setRoutes(r))
      .catch(() => undefined);
    const off = android.audio.onRoutes(setRoutes);
    return () => {
      live = false;
      off();
    };
  }, [android]);
  const choose = (route: AudioRoute) => {
    android.audio
      .setRoute(route)
      .then(setRoutes)
      .catch(() => useToasts.getState().push({ kind: "warning", title: t("voice.route.failed") }));
  };
  const current = routes?.current ?? null;
  const Icon = ICONS[current ?? "speaker"];
  const label = current ? t("voice.route.button", { route: routeLabel(current, t) }) : t("voice.route.title");
  return (
    <>
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        data-testid="voice-route"
        data-route={current ?? undefined}
        onClick={(e) => (menu.open ? menu.close() : menu.openAt(e.currentTarget))}
        className={`inline-flex min-h-10 min-w-10 items-center justify-center rounded-md text-fg-1 hover:bg-bg-3 hover:text-fg-0 ${className}`}
      >
        <Icon size={20} />
      </button>
      {menu.open && menu.anchor && routes && <ContextMenu entries={audioRouteMenu(routes, choose, t)} anchor={menu.anchor} onClose={menu.close} label={t("voice.route.title")} testId="voice-route-menu" />}
    </>
  );
}

/** The route button where the app can switch the output (the Android app); nothing elsewhere. */
export function AudioRouteButton({ className = "" }: { className?: string }) {
  const android = platform().android;
  return android ? <RouteButton android={android} className={className} /> : null;
}
