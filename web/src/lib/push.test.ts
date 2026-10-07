// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import en from "../i18n/en.json";
import de from "../i18n/de.json";
import { SW_STRING_KEYS, base64UrlToBytes, bytesToBase64Url, isIos, needsInstall, subscribedWithKey, subscriptionRequest, workerStrings } from "./push";

describe("web push helpers", () => {
  it("converts base64url keys both ways", () => {
    const key = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
    const bytes = base64UrlToBytes(key);
    expect(bytes.length).toBe(65);
    expect(bytes[0]).toBe(4);
    expect(bytesToBase64Url(bytes)).toBe(key);
    expect(bytesToBase64Url(bytes.buffer)).toBe(key);
    expect(bytesToBase64Url(null)).toBe("");
  });

  it("knows whether a subscription was made with the node's key", () => {
    const key = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
    const sub = { options: { applicationServerKey: base64UrlToBytes(key).buffer, userVisibleOnly: true } } as unknown as PushSubscription;
    expect(subscribedWithKey(sub, key)).toBe(true);
    expect(subscribedWithKey(sub, `${key}=`)).toBe(true);
    expect(subscribedWithKey(sub, "BOther")).toBe(false);
    expect(subscribedWithKey({ options: { applicationServerKey: null } } as unknown as PushSubscription, key)).toBe(false);
  });

  it("builds the node's request from the browser's subscription", () => {
    const json = { endpoint: "https://push.example/abc", expirationTime: null, keys: { p256dh: "p", auth: "a" } };
    expect(subscriptionRequest(json, "dev1")).toEqual({ endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" }, device_id: "dev1", expiration_time: null });
    expect(subscriptionRequest({ ...json, expirationTime: 1_900_000_000_000 }, null)).toEqual({ endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" }, expiration_time: 1_900_000_000_000 });
    expect(() => subscriptionRequest({ endpoint: "https://push.example/abc" }, null)).toThrow();
  });

  it("asks iPhone and iPad users to install the app first", () => {
    const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
    const ipad = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
    expect(isIos(iphone, 5)).toBe(true);
    expect(isIos(ipad, 5)).toBe(true);
    expect(isIos(ipad, 0)).toBe(false);
    expect(isIos("Mozilla/5.0 (Linux; Android 15) Chrome/140 Mobile", 5)).toBe(false);
    expect(needsInstall(true, false)).toBe(true);
    expect(needsInstall(true, true)).toBe(false);
    expect(needsInstall(false, false)).toBe(false);
  });

  it("hands the worker every text in both languages", () => {
    const strings = workerStrings((k) => k);
    expect(Object.keys(strings)).toEqual([...SW_STRING_KEYS]);
    for (const k of SW_STRING_KEYS) {
      expect((en as Record<string, string>)[`push.sw.${k}`], k).toBeTruthy();
      expect((de as Record<string, string>)[`push.sw.${k}`], k).toBeTruthy();
    }
  });
});
