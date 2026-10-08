// SPDX-License-Identifier: Apache-2.0
/**
 * The client as the desktop app sees it (docs/DESKTOP.md), in Chromium and the phone emulation: the Tauri runtime is
 * simulated with an init script that answers the shell's commands (`web/src/platform/tauri.ts`), so the node picker,
 * the explicit node base, Settings → App and the global hotkeys run against the real node. The built app itself is
 * covered by the WebDriver smoke test (apps/desktop/e2e/smoke.mjs).
 */
import { expect, test, type Page } from "@playwright/test";
import { NODE, createRoomViaApi, loginAs, registerViaApi, registerViaUi, tokenOf } from "./helpers";
import { FAKE_MEDIA } from "./voice-helpers";

// The hotkey test joins a voice channel: Chromium's fake microphone, no permission prompts.
test.use({ launchOptions: { args: FAKE_MEDIA }, permissions: ["microphone", "camera"] });

/**
 * A fake shell: the chosen node lives in sessionStorage (survives reloads like the app's config file); the hotkey
 * commands are logged there, and `window.__e2eHotkey(action, pressed)` plays the shell's event channel.
 */
async function asDesktopApp(page: Page, node: string | null = null) {
  await page.addInitScript((initial) => {
    const KEY = "e2e.desktop.node";
    if (initial && sessionStorage.getItem(KEY) === null) sessionStorage.setItem(KEY, initial);
    const HOTKEYS = "e2e.desktop.hotkeys";
    const log = (entry: string) => sessionStorage.setItem(HOTKEYS, JSON.stringify([...JSON.parse(sessionStorage.getItem(HOTKEYS) ?? "[]"), entry]));
    const w = window as unknown as Record<string, unknown>;
    w.isTauri = true;
    w.__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: { url?: string; action?: string; combo?: string; onEvent?: { onmessage: (m: unknown) => void } }) => {
        switch (cmd) {
          case "get_config":
            return { node: sessionStorage.getItem(KEY) };
          case "app_info":
            return { version: "0.2.0", updater: false };
          case "set_node": {
            const url = String(args.url);
            if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url)) throw "node_url.insecure";
            sessionStorage.setItem(KEY, url);
            return url;
          }
          case "open_external":
            return null;
          case "listen_hotkeys":
            w.__e2eHotkey = (action: string, pressed: boolean) => args.onEvent?.onmessage({ action, pressed });
            return null;
          case "register_hotkey":
            // Like hotkeys.rs: a key that types text needs Ctrl, Alt or Super.
            if (/^(Shift\+)?Key[A-Z]$/.test(String(args.combo))) throw "hotkey.typing_key";
            log(`register ${args.action} ${args.combo}`);
            return args.combo;
          case "unregister_hotkey":
            log(`unregister ${args.action}`);
            return null;
        }
        throw `unknown command ${cmd}`;
      },
      transformCallback: () => 0,
    };
  }, node);
}

test.describe("Desktop app (simulated shell)", () => {
  test("first start: the node picker refuses http://evil, accepts the node and continues to its login page", async ({ page }) => {
    await asDesktopApp(page);
    await page.goto("/rooms/x/channels/y");
    await expect(page.getByRole("heading", { name: "Wähle deinen Heimatknoten" })).toBeVisible();
    const input = page.getByLabel("Adresse des Knotens", { exact: true });
    await input.fill("http://evil");
    await page.getByRole("button", { name: "Verbinden", exact: true }).click();
    await expect(page.getByTestId("node-picker-error")).toContainText("https");
    await input.fill(NODE);
    await page.getByRole("button", { name: "Verbinden", exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByTestId("node-name")).toHaveText(/tavrn \(localhost\)/);
    // Passkeys need the node's origin: the app offers password and second factor only.
    await expect(page.getByRole("button", { name: "Mit Passkey anmelden" })).toHaveCount(0);
    // The picker fits the phone width without horizontal scrolling.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test("Settings → App: version, node and the way back to the picker", async ({ page, request }) => {
    const account = await registerViaApi(request, "desk");
    await asDesktopApp(page, NODE);
    await loginAs(page, account);
    await page.goto("/settings/app");
    await expect(page.getByTestId("app-version")).toHaveText("Version 0.2.0");
    await expect(page.getByTestId("app-node")).toHaveText(NODE);
    await expect(page.getByTestId("app-updates-unconfigured")).toBeVisible();
    await page.getByRole("link", { name: "Knoten wechseln" }).click();
    await expect(page).toHaveURL(/\/node$/);
    await expect(page.getByTestId("node-picker-current")).toContainText(NODE);
    await expect(page.getByTestId("node-picker-warning")).toBeVisible();
    await page.getByRole("link", { name: "Abbrechen" }).click();
    await expect(page).toHaveURL(/\/settings\/app$/);
  });

  test("the browser has neither the picker nor Settings → App", async ({ page, request }) => {
    const account = await registerViaApi(request, "web");
    await loginAs(page, account);
    await page.goto("/settings/profile");
    await expect(page.getByRole("link", { name: "App", exact: true })).toHaveCount(0);
    // Global hotkeys only in the app: the browser shows the hint.
    await page.goto("/settings/voice");
    await expect(page.getByTestId("desktop-hotkeys-hint")).toContainText("Desktop-App");
    await expect(page.getByTestId("desktop-hotkeys")).toHaveCount(0);
  });
});

test.describe("Desktop app: global hotkeys (simulated shell)", () => {
  const hotkeyLog = (page: Page) => page.evaluate(() => JSON.parse(sessionStorage.getItem("e2e.desktop.hotkeys") ?? "[]") as string[]);

  test("recorder with conflict check, restored at start, a press of the shell mutes the call", async ({ page, request }) => {
    test.setTimeout(180_000);
    await asDesktopApp(page, NODE);
    await registerViaUi(page, { prefix: "hotk" });
    await page.goto("/settings/voice");
    const section = page.getByTestId("desktop-hotkeys");
    await expect(section.getByTestId("hotkey-toggle_mute-key")).toHaveText("keins");

    // Ctrl+Shift+M for mute: the platform's key names, the shell's canonical spelling.
    await section.getByTestId("hotkey-toggle_mute-change").click();
    await expect(section.getByTestId("hotkey-toggle_mute-key")).toHaveText("Kombination drücken …");
    await page.keyboard.press("Control+Shift+KeyM");
    await expect(section.getByTestId("hotkey-toggle_mute-key")).toHaveText("Ctrl + Shift + M");
    expect(await hotkeyLog(page)).toContain("register toggle_mute Ctrl+Shift+KeyM");

    // The same combination for deafen is refused with a message, so is a key that types text.
    await section.getByTestId("hotkey-toggle_deafen-change").click();
    await page.keyboard.press("Control+Shift+KeyM");
    await expect(section.getByRole("alert")).toContainText("Stummschalten");
    await section.getByTestId("hotkey-toggle_deafen-change").click();
    await page.keyboard.press("KeyD");
    await expect(section.getByRole("alert")).toContainText("Alt");
    await expect(section.getByTestId("hotkey-toggle_deafen-key")).toHaveText("keins");
    // Escape cancels; F12 for deafen, then Backspace removes it again.
    await section.getByTestId("hotkey-toggle_deafen-change").click();
    await page.keyboard.press("Escape");
    await expect(section.getByTestId("hotkey-toggle_deafen-key")).toHaveText("keins");
    await section.getByTestId("hotkey-toggle_deafen-change").click();
    await page.keyboard.press("F12");
    await expect(section.getByTestId("hotkey-toggle_deafen-key")).toHaveText("F12");
    // The other direction: the push-to-talk key of the window may not be a global binding either.
    await page.getByTestId("mode-ptt").check();
    await page.getByTestId("ptt-capture").click();
    await page.keyboard.press("F12");
    await expect(page.getByTestId("ptt-settings").getByRole("alert")).toContainText("globales Tastenkürzel");
    await expect(page.getByTestId("ptt-key")).toHaveText("Backquote");
    await page.getByTestId("mode-vad").check();
    await section.getByTestId("hotkey-toggle_deafen-change").click();
    await page.keyboard.press("Backspace");
    await expect(section.getByTestId("hotkey-toggle_deafen-key")).toHaveText("keins");
    expect(await hotkeyLog(page)).toContain("unregister toggle_deafen");
    // The push-to-talk key of the window may not be a global binding.
    await section.getByTestId("hotkey-push_to_talk-change").click();
    await page.keyboard.press("Backquote");
    await expect(section.getByRole("alert")).toContainText("Push-to-Talk");
    // The phone layout keeps the page within the screen.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    // A new start hands the stored bindings to the shell again.
    await page.evaluate(() => sessionStorage.setItem("e2e.desktop.hotkeys", "[]"));
    await page.reload();
    await expect(page.getByTestId("desktop-hotkeys").getByTestId("hotkey-toggle_mute-key")).toHaveText("Ctrl + Shift + M");
    await expect.poll(() => hotkeyLog(page)).toEqual(expect.arrayContaining(["register toggle_mute Ctrl+Shift+KeyM", "unregister push_to_talk", "unregister toggle_deafen"]));

    // In a voice channel the shell's press toggles mute, the release does nothing, the next press unmutes.
    const room = await createRoomViaApi(request, await tokenOf(page), "Hotkeys");
    const voiceId = (room.channels as { id: string; kind: string }[]).find((c) => c.kind === "voice")!.id;
    await page.goto(`/rooms/${room.id}/channels/${voiceId}`);
    await page.getByTestId("voice-join").click();
    await expect(page.getByTestId("voice-e2ee")).toBeVisible({ timeout: 30_000 });
    const mute = page.getByTestId("voice-mute");
    await expect(mute).toHaveAttribute("aria-pressed", "false");
    const shell = (action: string, pressed: boolean) => page.evaluate(([a, p]) => (window as unknown as { __e2eHotkey: (a: string, p: boolean) => void }).__e2eHotkey(a as string, p as boolean), [action, pressed] as const);
    await shell("toggle_mute", true);
    await expect(mute).toHaveAttribute("aria-pressed", "true");
    await shell("toggle_mute", false);
    await expect(mute).toHaveAttribute("aria-pressed", "true");
    await shell("toggle_mute", true);
    await expect(mute).toHaveAttribute("aria-pressed", "false");
    await page.getByTestId("voice-leave").click();
  });
});
