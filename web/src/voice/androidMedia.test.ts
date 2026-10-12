// SPDX-License-Identifier: Apache-2.0
/** The Android app asks for a call's permissions right before their first use (docs/ANDROID.md "Permissions"). */
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetPlatform, setPlatform } from "../platform";
import { androidPlatform, fakeAndroid } from "../platform/androidTestPlatform";
import { androidMediaBlocked, prepareAndroidMedia } from "./androidMedia";

afterEach(() => resetPlatform());

describe("permissions of a call", () => {
  it("does nothing outside the Android app", async () => {
    await expect(prepareAndroidMedia("microphone")).resolves.toBeNull();
    expect(androidMediaBlocked()).toBe(false);
  });

  it("asks for the microphone, then headsets, and the notifications once", async () => {
    const android = fakeAndroid();
    setPlatform(androidPlatform(android));
    await expect(prepareAndroidMedia("microphone")).resolves.toBe("granted");
    await prepareAndroidMedia("microphone");
    await prepareAndroidMedia("camera");
    expect(vi.mocked(android.requestPermission).mock.calls.map((c) => c[0])).toEqual(["microphone", "bluetooth", "notifications", "microphone", "bluetooth", "camera"]);
  });

  it("remembers a blocked permission for the error message", async () => {
    const android = fakeAndroid({ permission: "blocked" });
    setPlatform(androidPlatform(android));
    await expect(prepareAndroidMedia("microphone")).resolves.toBe("blocked");
    expect(androidMediaBlocked()).toBe(true);
    expect(vi.mocked(android.requestPermission).mock.calls.map((c) => c[0])).toEqual(["microphone"]);
  });
});
