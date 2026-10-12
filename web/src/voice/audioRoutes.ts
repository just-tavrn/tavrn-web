// SPDX-License-Identifier: Apache-2.0
/**
 * The Android app's audio output switch (docs/ANDROID.md "Audio output"): the menu of the route button in the voice
 * controls, a pure function over the routes the shell reports (`PlatformAndroid.audio`), so it is unit-tested. The
 * shell decides the defaults (a headset when connected, else the speaker) and keeps the choice while its device stays.
 */
import { menuItem, menuLabel, normalizeMenu, type MenuEntry } from "../components/ContextMenu";
import type { AudioRoute, AudioRoutes } from "../platform/types";

type T = (key: string, params?: Record<string, string | number>) => string;

/** The route's name in the menu and the button's label. */
export const routeLabel = (route: AudioRoute, t: T): string => t(`voice.route.${route}`);

/** The route button's menu: every connected output, the one in use checked; a choice closes the menu. */
export function audioRouteMenu(routes: AudioRoutes, choose: (route: AudioRoute) => void, t: T): MenuEntry[] {
  return normalizeMenu([
    menuLabel("label", t("voice.route.title")),
    ...routes.available.map((route) => menuItem(`route:${route}`, routeLabel(route, t), () => choose(route), { checked: routes.current === route, keepOpen: false })),
  ]);
}
