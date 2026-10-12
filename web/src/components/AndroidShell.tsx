// SPDX-License-Identifier: Apache-2.0
/**
 * The Android app's wiring inside the router (docs/ANDROID.md): the back gesture and the system bars
 * (`platform/androidShell.ts`; links: `DeepLinkPrompt`). Renders nothing; outside the Android app it does nothing.
 */
import { useEffect } from "react";
import { useNavigate } from "react-router";
import { platform } from "../platform";
import { startAndroidShell } from "../platform/androidShell";

export function AndroidShell() {
  const navigate = useNavigate();
  useEffect(() => {
    const p = platform();
    if (!p.android) return;
    return startAndroidShell({ android: p.android, back: () => navigate(-1) });
  }, [navigate]);
  return null;
}
