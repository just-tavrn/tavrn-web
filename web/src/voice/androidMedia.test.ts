// SPDX-License-Identifier: Apache-2.0
/** The Android app asks for a call's permissions right before their first use (docs/ANDROID.md "Permissions"). */
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetPlatform, setPlatform, type PermissionAnswer } from "../platform";
import { androidPlatform, fakeAndroid } from "../platform/androidTestPlatform";
import { androidMediaBlocked, prepareAndroidMedia } from "./androidMedia";

afterEach(() => resetPlatform());

describe("permissions of a call", () => {
  it("does nothing outside the Android app", async () => {
    await expect(prepareAndroidMedia("microphone")).resolves.toBeNull();
    expect(androidMediaBlocked()).toBe(false);
  });

  it("asks for the microphone, then headsets, and the notifications once, one request at a time", async () => {
    const android = fakeAndroid();
    setPlatform(androidPlatform(android));
    await expect(prepareAndroidMedia("microphone")).resolves.toBe("granted");
    await prepareAndroidMedia("microphone");
    await prepareAndroidMedia("camera");
    expect(vi.mocked(android.requestPermission).mock.calls.map((c) => c[0])).toEqual(["microphone", "bluetooth", "notifications", "microphone", "bluetooth", "camera"]);
  });

  it("the join waits for the microphone only; headsets and notifications follow without holding it", async () => {
    const android = fakeAndroid();
    const pending: Array<() => void> = [];
    let open = 0;
    let most = 0;
    vi.mocked(android.requestPermission).mockImplementation((p) => {
      open++;
      most = Math.max(most, open);
      // The microphone is answered at once; the user takes their time with the other two dialogs.
      if (p === "microphone") return Promise.resolve<PermissionAnswer>("granted").finally(() => open--);
      return new Promise<PermissionAnswer>((resolve) => pending.push(() => (open--, resolve("granted"))));
    });
    // A fresh start of the app (the notifications are asked once per start).
    vi.resetModules();
    const platformModule = await import("../platform");
    const { prepareAndroidMedia } = await import("./androidMedia");
    platformModule.setPlatform(androidPlatform(android));
    await expect(prepareAndroidMedia("microphone")).resolves.toBe("granted");
    // Resolved while the headset dialog is still open.
    expect(pending).toHaveLength(1);
    pending.shift()!();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending.shift()!();
    await vi.waitFor(() => expect(vi.mocked(android.requestPermission).mock.calls.map((c) => c[0])).toEqual(["microphone", "bluetooth", "notifications"]));
    expect(most).toBe(1);
    platformModule.resetPlatform();
  });

  it("remembers a blocked permission for the error message", async () => {
    const android = fakeAndroid({ permission: "blocked" });
    setPlatform(androidPlatform(android));
    await expect(prepareAndroidMedia("microphone")).resolves.toBe("blocked");
    expect(androidMediaBlocked()).toBe(true);
    expect(vi.mocked(android.requestPermission).mock.calls.map((c) => c[0])).toEqual(["microphone"]);
  });
});
