// SPDX-License-Identifier: Apache-2.0
/** The Android app's platform (`tauri.ts` with `tauriAndroid.ts`), with the Tauri IPC mocked as the shell on Android. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Channel } from "@tauri-apps/api/core";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { createTauriPlatform } from "./tauri";
import { voiceNotice } from "./tauriAndroid";
import type { ShellEvent } from "./shellEvents";

type Calls = Array<{ cmd: string; args: Record<string, unknown> }>;

function android(release: unknown = null, info: Record<string, unknown> = {}) {
  const calls: Calls = [];
  const state: { channel: Channel<ShellEvent> | null } = { channel: null };
  mockWindows("main");
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args: a });
    switch (cmd) {
      case "get_config":
        return { node: "https://tavrn.example", web: "https://app.tavrn.example", domain: "tavrn.example" };
      case "app_info":
        return { version: "0.4.0", updater: false, os: "android" };
      case "android_info":
        return { sdk: 34, webauthn: true, distributors: ["io.heckel.ntfy"], distributor: null, notifications: "prompt", battery_exempt: false, keep_connection: false, insets: { top: 24, right: 0, bottom: 48, left: 0, keyboard: 0 }, ...info };
      case "passkey_get":
        return { credential: { id: "Y3JlZA", response: { clientDataJSON: "e30" } }, prf: null };
      case "shell_events":
        state.channel = a.onEvent as Channel<ShellEvent>;
        return null;
      case "android_permission":
        return a.permission === "camera" ? "blocked" : "granted";
      case "android_push_register":
        return { endpoint: "https://ntfy.example/upX", p256dh: "B".repeat(87), auth: "a".repeat(22) };
      case "android_check_update":
        if (typeof release === "string") throw release;
        return release;
      case "get_update_channel":
        return "stable";
      case "set_update_channel":
        return null;
      case "android_audio_routes":
        return { available: ["speaker", "earpiece"], current: "speaker" };
      case "android_audio_route":
        return { available: ["speaker", "earpiece"], current: a.route };
      case "android_orientation":
        if (a.lock === "sideways") throw "android.invalid";
        return null;
      case "android_voice":
      case "android_push_config":
      case "android_keep_connection":
      case "android_background":
      case "open_external":
      case "open_connect":
      case "close_connect":
      case "notify":
        return null;
    }
    throw `unknown command ${cmd}`;
  });
  const emit = (event: ShellEvent) => state.channel?.onmessage(event);
  return { calls, emit };
}

beforeEach(() => {
  (window as unknown as { isTauri?: boolean }).isTauri = true;
});

afterEach(() => {
  clearMocks();
  Reflect.deleteProperty(window, "isTauri");
});

describe("the Android app's platform", () => {
  it("is an app of its own kind, without the desktop's members", async () => {
    const { calls } = android();
    const p = await createTauriPlatform(document.implementation.createHTMLDocument("app"));
    expect(p.kind).toBe("android");
    expect(p.isDesktop).toBe(true);
    expect(p.android?.sdk).toBe(34);
    expect(p.android?.webauthn).toBe(true);
    // An older shell reports no Credential Manager: no native passkeys.
    expect(p.android?.passkeys).toBe(false);
    expect(p.passkeys).toBeUndefined();
    expect(p.android?.insets()).toEqual({ top: 24, right: 0, bottom: 48, left: 0, keyboard: 0 });
    for (const desktopOnly of ["hotkeys", "voice", "keystore"] as const) expect(p[desktopOnly]).toBeUndefined();
    expect(calls.map((c) => c.cmd)).not.toContain("listen_hotkeys");
    expect(p.updater).toBeDefined();
  });

  it("runs passkeys through the Credential Manager where the shell reports it, with the app's origin", async () => {
    const origin = `android:apk-key-hash:${"A".repeat(43)}`;
    const { calls } = android(null, { passkeys: true, origin });
    const p = await createTauriPlatform(document.implementation.createHTMLDocument("app"));
    expect(p.android?.origin).toBe(origin);
    expect(p.android?.passkeys).toBe(true);
    const r = await p.passkeys!.get({ publicKey: { challenge: "AAAA" } });
    expect(r.credential.id).toBe("Y3JlZA");
    expect(calls.find((c) => c.cmd === "passkey_get")?.args).toEqual({ options: { publicKey: { challenge: "AAAA" } } });
  });

  it("signs in on the node's page in the browser as the Android app", async () => {
    const { calls } = android();
    const p = await createTauriPlatform(document.implementation.createHTMLDocument("app"));
    await p.auth?.reopen?.("https://app.tavrn.example/connect?session=x");
    expect(calls.at(-1)).toEqual({ cmd: "open_connect", args: { url: "https://app.tavrn.example/connect?session=x" } });
  });

  it("keeps the link that started the app until the prompt listens (another member took the channel first)", async () => {
    const { emit } = android();
    const p = await createTauriPlatform(document.implementation.createHTMLDocument("app"));
    // The shell hands its waiting link to the channel's first listener: the insets member of the platform.
    emit({ kind: "link", url: "tavrn://invite/chat.example/Code_1234" });
    emit({ kind: "link", url: "tavrn://room/chat.example/R1" });
    const seen: string[] = [];
    const stop = p.links!.subscribe((url) => seen.push(url));
    expect(seen).toEqual(["tavrn://invite/chat.example/Code_1234", "tavrn://room/chat.example/R1"]);
    emit({ kind: "link", url: "tavrn://room/chat.example/R2" });
    expect(seen).toHaveLength(3);
    stop();
    for (let i = 0; i < 20; i++) emit({ kind: "link", url: `tavrn://room/chat.example/R${i}` });
    const later: string[] = [];
    p.links!.subscribe((url) => later.push(url));
    expect(later).toHaveLength(8);
  });

  it("hands the shell's events to their listeners", async () => {
    const { emit } = android();
    const p = await createTauriPlatform(document.implementation.createHTMLDocument("app"));
    const seen: string[] = [];
    p.android?.onBack(() => seen.push("back"));
    p.links?.subscribe((url) => seen.push(`link ${url}`));
    p.android?.onInsets((i) => seen.push(`insets ${i.top}`));
    p.android?.push.onEndpoint((k) => seen.push(`endpoint ${k.endpoint}`));
    p.notifications?.onOpen((path) => seen.push(`open ${path}`));
    p.tray?.onAction((a) => seen.push(`tray ${a}`));
    emit({ kind: "back" });
    emit({ kind: "link", url: "https://app.tavrn.example/invite/abcd" });
    emit({ kind: "insets", top: 30, right: 0, bottom: 0, left: 0, keyboard: 280 });
    emit({ kind: "push_endpoint", endpoint: "https://ntfy.example/up2", p256dh: "p", auth: "a" });
    emit({ kind: "open", path: "/conversations/1" });
    emit({ kind: "open", path: "//evil.example" });
    emit({ kind: "tray", action: "leave" });
    expect(seen).toEqual(["back", "link https://app.tavrn.example/invite/abcd", "insets 30", "endpoint https://ntfy.example/up2", "open /conversations/1", "tray leave"]);
    expect(p.android?.insets().keyboard).toBe(280);
  });

  it("drives the voice notification without flicker", async () => {
    const { calls } = android();
    const p = await createTauriPlatform(document.implementation.createHTMLDocument("app"));
    const labels = { tooltip: "tavrn · Lounge · Speaking", show: "s", hide: "h", mute: "Mute microphone", deafen: "d", leave: "Leave voice channel", quit: "q" };
    const extra = { title: "In voice channel Lounge (Gaming)", text: "Connected", unmute: "Unmute microphone", camera: false };
    await p.tray?.set("connected", labels, extra);
    await p.tray?.set("speaking", labels, extra);
    await p.tray?.set("connected", labels, extra);
    const voice = calls.filter((c) => c.cmd === "android_voice");
    expect(voice).toHaveLength(1);
    expect(voice[0]?.args.notice).toEqual({ state: "connected", title: "In voice channel Lounge (Gaming)", text: "Connected", mute: "Mute microphone", unmute: "Unmute microphone", leave: "Leave voice channel", camera: false });
    await p.tray?.set("muted", labels, { ...extra, text: "Microphone muted", camera: true });
    await p.tray?.set("disconnected", labels, extra);
    expect(calls.filter((c) => c.cmd === "android_voice").map((c) => (c.args.notice as { state: string }).state)).toEqual(["connected", "muted", "disconnected"]);
    await expect(p.tray?.status()).resolves.toMatchObject({ available: false });
  });

  it("asks for permissions and registers push through the shell", async () => {
    const { calls } = android();
    const p = await createTauriPlatform(document.implementation.createHTMLDocument("app"));
    await expect(p.android?.requestPermission("microphone")).resolves.toBe("granted");
    await expect(p.android?.requestPermission("camera")).resolves.toBe("blocked");
    await expect(p.android?.push.register("BKEY", null)).resolves.toMatchObject({ endpoint: "https://ntfy.example/upX" });
    await p.android?.push.configure({ app: "tavrn" }, "tavrn.example");
    expect(calls.find((c) => c.cmd === "android_push_register")?.args).toEqual({ vapid: "BKEY", distributor: null });
    expect(calls.find((c) => c.cmd === "android_push_config")?.args).toEqual({ config: { strings: { app: "tavrn" }, home_node: "tavrn.example" } });
  });

  it("routes the call's audio and follows the routes' changes", async () => {
    const { calls, emit } = android();
    const p = await createTauriPlatform(document.implementation.createHTMLDocument("app"));
    await expect(p.android?.audio.routes()).resolves.toEqual({ available: ["speaker", "earpiece"], current: "speaker" });
    await expect(p.android?.audio.setRoute("earpiece")).resolves.toEqual({ available: ["speaker", "earpiece"], current: "earpiece" });
    expect(calls.find((c) => c.cmd === "android_audio_route")?.args).toEqual({ route: "earpiece" });
    const seen: unknown[] = [];
    p.android?.audio.onRoutes((r) => seen.push(r));
    emit({ kind: "audio_routes", available: ["speaker", "earpiece", "bluetooth"], current: "bluetooth" });
    emit({ kind: "back" });
    expect(seen).toEqual([{ available: ["speaker", "earpiece", "bluetooth"], current: "bluetooth" }]);
  });

  it("locks the orientation natively and releases it", async () => {
    const { calls } = android();
    const p = await createTauriPlatform(document.implementation.createHTMLDocument("app"));
    await p.android?.lockOrientation("landscape");
    await p.android?.lockOrientation(null);
    expect(calls.filter((c) => c.cmd === "android_orientation").map((c) => c.args)).toEqual([{ lock: "landscape" }, { lock: null }]);
  });

  it("links to a newer release's APK in the browser", async () => {
    const { calls } = android({ version: "0.5.0", notes: "n", url: "https://github.com/just-tavrn/tavrn-web/releases/download/v0.5.0/Tavrn_0.5.0_android-arm64.apk" });
    const p = await createTauriPlatform(document.implementation.createHTMLDocument("app"));
    const update = await p.updater?.check();
    expect(update?.version).toBe("0.5.0");
    await update?.install();
    expect(calls.at(-1)).toEqual({ cmd: "open_external", args: { url: "https://github.com/just-tavrn/tavrn-web/releases/download/v0.5.0/Tavrn_0.5.0_android-arm64.apk" } });
  });

  it("names why the check failed and offers the update channel", async () => {
    const { calls } = android("update.no_release");
    const p = await createTauriPlatform(document.implementation.createHTMLDocument("app"));
    await expect(p.updater?.check()).rejects.toMatchObject({ problem: { code: "update.no_release" } });
    await expect(p.updater?.channel?.get()).resolves.toBe("stable");
    await p.updater?.channel?.set("beta");
    expect(calls.at(-1)).toEqual({ cmd: "set_update_channel", args: { channel: "beta" } });
  });
});

describe("the voice notice", () => {
  it("falls back to the tray's texts", () => {
    const labels = { tooltip: "tavrn · X · Muted", show: "", hide: "", mute: "Mute", deafen: "", leave: "Leave", quit: "" };
    expect(voiceNotice("deafened", labels, undefined)).toEqual({ state: "deafened", title: "tavrn · X · Muted", text: "tavrn · X · Muted", mute: "Mute", unmute: "Mute", leave: "Leave", camera: false });
  });
});

describe("downloads in the Android app", () => {
  it("stream the file to the document the user picked", async () => {
    const { createAndroidSaveFile } = await import("./tauriAndroid");
    const calls: Array<{ cmd: string; args: unknown; headers?: unknown }> = [];
    const call = async (cmd: string, args?: unknown, options?: { headers?: unknown }) => {
      calls.push({ cmd, args, headers: options?.headers });
      if (cmd === "android_save_begin") return { status: "ready", id: "0f8fad5b-d9cb-469f-a165-70867728950e" };
      if (cmd === "android_save_end") return { name: "key.txt" };
      return null;
    };
    const out = await createAndroidSaveFile(call as never)({ name: "key.txt", data: new TextEncoder().encode("secret"), mime: "text/plain" });
    expect(out).toEqual({ status: "saved", name: "key.txt", path: "", folder: "" });
    expect(calls.map((c) => c.cmd)).toEqual(["android_save_begin", "android_save_chunk", "android_save_end"]);
    expect(calls[0]?.args).toEqual({ name: "key.txt", mime: "text/plain", size: 6 });
    expect(calls[1]?.args).toEqual({ id: "0f8fad5b-d9cb-469f-a165-70867728950e", data: btoa("secret") });
  });

  it("sends a large file in pieces of 1 MiB", async () => {
    const { createAndroidSaveFile, ANDROID_SAVE_CHUNK_BYTES } = await import("./tauriAndroid");
    const sizes: number[] = [];
    const call = async (cmd: string, args?: { data?: string }) => {
      if (cmd === "android_save_begin") return { status: "ready", id: "0f8fad5b-d9cb-469f-a165-70867728950e" };
      if (cmd === "android_save_chunk") sizes.push(atob(args?.data ?? "").length);
      if (cmd === "android_save_end") return { name: "big.bin" };
      return null;
    };
    await createAndroidSaveFile(call as never)({ name: "big.bin", data: new Uint8Array(2.5 * ANDROID_SAVE_CHUNK_BYTES) });
    expect(sizes).toEqual([ANDROID_SAVE_CHUNK_BYTES, ANDROID_SAVE_CHUNK_BYTES, ANDROID_SAVE_CHUNK_BYTES / 2]);
  });

  it("cancel with the picker and remove a half-written file", async () => {
    const { createAndroidSaveFile } = await import("./tauriAndroid");
    await expect(createAndroidSaveFile(async () => ({ status: "cancelled" }))({ name: "a", data: new Uint8Array(1) })).resolves.toEqual({ status: "cancelled" });
    const calls: string[] = [];
    const failing = async (cmd: string) => {
      calls.push(cmd);
      if (cmd === "android_save_begin") return { status: "ready", id: "x" };
      if (cmd === "android_save_chunk") throw "download.failed";
      return null;
    };
    await expect(createAndroidSaveFile(failing as never)({ name: "a", data: new Uint8Array(1) })).rejects.toBe("download.failed");
    expect(calls).toEqual(["android_save_begin", "android_save_chunk", "android_save_abort"]);
  });
});
