// SPDX-License-Identifier: Apache-2.0
/**
 * Passkeys in the Android app's webview (docs/ANDROID.md "Passkeys"): only on Android 14+ with a webview that runs
 * WebAuthn for the app, and only while the home node lists the app's origin in `webauthn.origins` (PROTOCOL.md
 * §5a.4); otherwise the browser's connect flow.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { loadNodeWebauthn, parseNodeWebauthn, passkeyBlocker, passkeysSupported, resetNodeWebauthn, useNodeWebauthn, usePasskeyBlocker } from "./passkeys";
import { FAKE_APP_ORIGIN, androidPlatform, fakeAndroid } from "../platform/androidTestPlatform";
import { resetPlatform, setPlatform } from "../platform";
import { mockFetch } from "../test/render";

const WEB = "https://app.tavrn.org";
const OTHER_APP = `android:apk-key-hash:${"B".repeat(42)}A`;

beforeEach(() => {
  resetNodeWebauthn();
  vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
  Object.defineProperty(navigator, "credentials", { value: {}, configurable: true });
});

afterEach(() => {
  resetPlatform();
  resetNodeWebauthn();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "credentials");
});

describe("passkeys in the Android app", () => {
  const app = (opts: Parameters<typeof fakeAndroid>[0] = {}) => androidPlatform(fakeAndroid({ webauthn: true, ...opts }), "tavrn.org");

  it("run in the webview when the node accepts the app's origin", () => {
    expect(passkeyBlocker(app(), [WEB, FAKE_APP_ORIGIN])).toBeNull();
    expect(passkeysSupported(app(), [WEB, OTHER_APP, FAKE_APP_ORIGIN])).toBe(true);
  });

  it("go through the browser when the node does not list the app's origin (another key, or none)", () => {
    expect(passkeyBlocker(app(), [WEB])).toBe("node");
    expect(passkeyBlocker(app(), [WEB, OTHER_APP])).toBe("node");
    expect(passkeysSupported(app(), [WEB])).toBe(false);
  });

  it("go through the browser below Android 14, without the webview's WebAuthn or without a known origin", () => {
    expect(passkeyBlocker(app({ webauthn: false }), [WEB, FAKE_APP_ORIGIN])).toBe("platform");
    expect(passkeyBlocker(app({ origin: null }), [WEB, FAKE_APP_ORIGIN])).toBe("platform");
  });

  it("wait for the node's answer before they decide", () => {
    expect(passkeyBlocker(app(), null)).toBe("pending");
    expect(passkeysSupported(app())).toBe(false);
  });

  it("read the node's webauthn object defensively", () => {
    expect(parseNodeWebauthn({ rp_id: "tavrn.org", origins: [WEB, FAKE_APP_ORIGIN] })).toEqual({ rpId: "tavrn.org", origins: [WEB, FAKE_APP_ORIGIN] });
    expect(parseNodeWebauthn({ rp_id: "tavrn.org" })).toEqual({ rpId: "tavrn.org", origins: null });
    expect(parseNodeWebauthn({ rp_id: 1, origins: [WEB, 2] })).toEqual({ rpId: null, origins: null });
    expect(parseNodeWebauthn(undefined)).toEqual({ rpId: null, origins: null });
  });

  it("ask the home node once and answer from then on without asking", async () => {
    const calls = mockFetch({ "/api/v1/node": { body: { domain: "tavrn.org", webauthn: { rp_id: "tavrn.org", origins: [WEB, FAKE_APP_ORIGIN] } } } });
    setPlatform(app());
    await loadNodeWebauthn();
    await loadNodeWebauthn();
    expect(calls.filter((c) => c.url.includes("/api/v1/node"))).toHaveLength(1);
    expect(useNodeWebauthn.getState().origins).toEqual([WEB, FAKE_APP_ORIGIN]);
    expect(passkeysSupported()).toBe(true);
  });

  it("the hook asks the node and renders again with its answer", async () => {
    mockFetch({ "/api/v1/node": { body: { domain: "tavrn.org", webauthn: { rp_id: "tavrn.org", origins: [WEB, FAKE_APP_ORIGIN] } } } });
    setPlatform(app());
    const { result } = renderHook(() => usePasskeyBlocker());
    expect(result.current).toBe("pending");
    await waitFor(() => expect(result.current).toBeNull());
  });

  it("the hook names the node as the reason when it does not accept the app (also an older node without the list)", async () => {
    mockFetch({ "/api/v1/node": { body: { domain: "tavrn.org", webauthn: { rp_id: "tavrn.org" } } } });
    setPlatform(app());
    const { result } = renderHook(() => usePasskeyBlocker());
    await waitFor(() => expect(result.current).toBe("node"));
    act(() => useNodeWebauthn.setState({ origins: [WEB] }));
    expect(result.current).toBe("node");
  });

  it("the hook falls back to the browser without a reason when the node cannot be asked", async () => {
    mockFetch({ "/api/v1/node": { status: 503, body: { code: "x", status: 503, title: "down", detail: "", type: "x" } } });
    setPlatform(app());
    const { result } = renderHook(() => usePasskeyBlocker());
    await waitFor(() => expect(result.current).toBe("platform"));
  });

  it("the browser and the desktop app do not ask the node for origins", () => {
    const calls = mockFetch({});
    const { result } = renderHook(() => usePasskeyBlocker());
    expect(result.current).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
