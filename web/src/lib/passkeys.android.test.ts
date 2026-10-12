// SPDX-License-Identifier: Apache-2.0
/** Passkeys in the Android app's webview only on Android 14+ and for associated relying parties (docs/ANDROID.md "Passkeys"). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_PASSKEY_RP_IDS, passkeysSupported } from "./passkeys";
import { androidPlatform, fakeAndroid } from "../platform/androidTestPlatform";

beforeEach(() => {
  vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
  Object.defineProperty(navigator, "credentials", { value: {}, configurable: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "credentials");
});

describe("passkeys in the Android app", () => {
  it("run in the webview only with WebAuthn for the app and an associated relying party", () => {
    expect(passkeysSupported(androidPlatform(fakeAndroid({ webauthn: true }), "tavrn.org"), ["tavrn.org"])).toBe(true);
    // Below Android 14, or a webview without it: the browser's connect flow.
    expect(passkeysSupported(androidPlatform(fakeAndroid({ webauthn: false }), "tavrn.org"), ["tavrn.org"])).toBe(false);
    // Another node: its passkeys are not associated with the app.
    expect(passkeysSupported(androidPlatform(fakeAndroid({ webauthn: true }), "other.example"), ["tavrn.org"])).toBe(false);
  });

  it("are off for every node until one accepts the app's origin", () => {
    expect(APP_PASSKEY_RP_IDS).toEqual([]);
    expect(passkeysSupported(androidPlatform(fakeAndroid({ webauthn: true }), "tavrn.org"))).toBe(false);
  });
});
