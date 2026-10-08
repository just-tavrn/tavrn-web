// SPDX-License-Identifier: Apache-2.0
/**
 * The client as the desktop app sees it (docs/DESKTOP.md), in Chromium and the phone emulation: the Tauri runtime is
 * simulated with an init script that answers the shell's commands (`web/src/platform/tauri.ts`), so the node picker,
 * the explicit node base, Settings → App and the global hotkeys run against the real node. The built app itself is
 * covered by the WebDriver smoke test (apps/desktop/e2e/smoke.mjs).
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import { NODE, createRoomViaApi, loginAs, nextTotpCode, registerViaApi, registerViaUi, tokenOf, type Account } from "./helpers";
import { FAKE_MEDIA, cues } from "./voice-helpers";

// The hotkey test joins a voice channel: Chromium's fake microphone, no permission prompts.
test.use({ launchOptions: { args: FAKE_MEDIA }, permissions: ["microphone", "camera"] });

/**
 * A fake shell: the chosen node (with its web origin and domain) lives in sessionStorage (survives reloads like the
 * app's config file). `resolve_node` asks the test node's well-known (the real shell runs FEDERATION.md §1.4);
 * `open_connect` records the sign-in page instead of opening a window, `close_connect` records that it closed. The
 * hotkey commands are logged there too, and `window.__e2eHotkey(action, pressed)` plays the shell's event channel.
 */
async function asDesktopApp(page: Page, node: string | null = null) {
  await page.addInitScript(
    ({ initial, testNode }) => {
      const KEY = "e2e.desktop.node";
      if (initial && sessionStorage.getItem(KEY) === null) sessionStorage.setItem(KEY, initial);
      const HOTKEYS = "e2e.desktop.hotkeys";
      const log = (entry: string) => sessionStorage.setItem(HOTKEYS, JSON.stringify([...JSON.parse(sessionStorage.getItem(HOTKEYS) ?? "[]"), entry]));
      const w = window as unknown as Record<string, unknown>;
      w.isTauri = true;
      w.__TAURI_INTERNALS__ = {
        invoke: async (cmd: string, args: { url?: string; web?: string | null; domain?: string | null; action?: string; combo?: string; onEvent?: { onmessage: (m: unknown) => void } }) => {
          switch (cmd) {
            case "get_config":
              return { node: sessionStorage.getItem(KEY), web: sessionStorage.getItem(`${KEY}.web`), domain: sessionStorage.getItem(`${KEY}.domain`) };
            case "app_info":
              return { version: "0.2.0", updater: false };
            case "set_node": {
              const url = String(args.url);
              if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url)) throw "node_url.insecure";
              sessionStorage.setItem(KEY, url);
              for (const k of ["web", "domain"] as const) {
                const v = args[k];
                if (v) sessionStorage.setItem(`${KEY}.${k}`, v);
                else sessionStorage.removeItem(`${KEY}.${k}`);
              }
              return url;
            }
            case "resolve_node": {
              const domain = String((args as { domain?: string }).domain);
              if (domain !== "localhost") throw { code: "resolve.not_found", step: "direct", domain };
              const doc = await (await fetch(`${testNode}/.well-known/tavrn`)).json();
              return { domain: doc.domain, api: `${testNode}/api/v1`, ws: `${testNode.replace(/^http/, "ws")}/api/v1/ws`, web: doc.web, source: "well_known" };
            }
            case "open_connect": {
              const opened = JSON.parse(sessionStorage.getItem("e2e.desktop.connect") ?? "[]") as string[];
              sessionStorage.setItem("e2e.desktop.connect", JSON.stringify([...opened, String(args.url)]));
              return null;
            }
            case "close_connect":
              sessionStorage.setItem("e2e.desktop.connect.closed", "1");
              return null;
            case "open_external":
              return null;
            case "listen_hotkeys":
              w.__e2eHotkey = (action: string, pressed: boolean) => args.onEvent?.onmessage({ action, pressed });
              return null;
            case "register_hotkey":
              // Like hotkeys.rs: any known key, a modifier alone or a combination (observed, never grabbed).
              if (String(args.combo).includes("Escape")) throw "hotkey.invalid";
              log(`register ${args.action} ${args.combo}`);
              return args.combo;
            case "unregister_hotkey":
              log(`unregister ${args.action}`);
              return null;
            case "set_hotkeys_enabled":
              log(`enabled ${(args as { enabled?: boolean }).enabled}`);
              return !!(args as { enabled?: boolean }).enabled;
          }
          throw `unknown command ${cmd}`;
        },
        transformCallback: () => 0,
      };
    },
    { initial: node, testNode: NODE },
  );
}

/** The sign-in page the app asked the shell to open. */
async function openedConnectPage(page: Page): Promise<string> {
  let url = "";
  await expect
    .poll(async () => {
      url = await page.evaluate(() => (JSON.parse(sessionStorage.getItem("e2e.desktop.connect") ?? "[]") as string[]).at(-1) ?? "");
      return url;
    })
    .toMatch(/\/connect\?session=[A-Za-z0-9_-]{43}&state=/);
  return url;
}

/** The node's page in a window of its own (another browser context: its own storage, like the shell's second webview). */
async function signInOnNodePage(browser: Browser, url: string, account: Account) {
  const context = await browser.newContext({ locale: "de-DE" });
  const page = await context.newPage();
  await page.goto(url);
  await page.getByLabel("Benutzername", { exact: true }).fill(account.username);
  await page.getByLabel("Passwort", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await page.getByLabel("6-stelliger Code", { exact: true }).fill(await nextTotpCode(account));
  await page.getByRole("button", { name: "Bestätigen", exact: true }).click();
  await expect(page.getByTestId("connect-text")).toContainText("Desktop app");
  await page.getByTestId("connect-allow").click();
  await expect(page.getByTestId("connect-done")).toBeVisible();
  await context.close();
}

test.describe("Desktop app (simulated shell)", () => {
  test("first start: the node picker refuses http://evil, accepts the node and continues to its login page", async ({ page }) => {
    await asDesktopApp(page);
    await page.goto("/rooms/x/channels/y");
    await expect(page.getByRole("heading", { name: "Wähle deinen Heimatknoten" })).toBeVisible();
    await page.getByRole("button", { name: "Erweitert: Knoten-URL" }).click();
    const input = page.getByLabel("Adresse des Knotens", { exact: true });
    await input.fill("http://evil");
    await page.getByRole("button", { name: "Verbinden", exact: true }).click();
    await expect(page.getByTestId("node-picker-error")).toContainText("https");
    await input.fill(NODE);
    await page.getByRole("button", { name: "Verbinden", exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByTestId("node-name")).toHaveText(/tavrn \(localhost\)/);
    // Passkeys need the node's origin: the app signs in on the node's page for them.
    await expect(page.getByTestId("node-page-signin")).toBeVisible();
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

  test("address first: the picker finds the node of the account and the login continues with the username", async ({ page, request }) => {
    const account = await registerViaApi(request, "addr");
    await asDesktopApp(page);
    await page.goto("/");
    await page.getByLabel("Deine Adresse", { exact: true }).fill("someone@nowhere.example");
    await page.getByRole("button", { name: "Verbinden", exact: true }).click();
    await expect(page.getByTestId("node-picker-error")).toContainText("Kein Knoten für nowhere.example gefunden");
    await page.getByLabel("Deine Adresse", { exact: true }).fill(`${account.username}@localhost`);
    await page.getByRole("button", { name: "Verbinden", exact: true }).click();
    await expect(page).toHaveURL(/\/login\?username=/);
    await expect(page.getByLabel("Benutzername oder Adresse", { exact: true })).toHaveValue(account.username);
    await page.getByLabel("Passwort", { exact: true }).fill(account.password);
    await page.getByRole("button", { name: "Anmelden", exact: true }).click();
    await page.getByLabel("6-stelliger Code", { exact: true }).fill(await nextTotpCode(account));
    await page.getByRole("button", { name: "Bestätigen", exact: true }).click();
    await expect(page.getByTestId("encryption-title")).toHaveText("Dein Wiederherstellungsschlüssel", { timeout: 20_000 });
  });

  test("sign-in on the node's page: the app waits, the page confirms, the app continues signed in", async ({ page, request, browser }) => {
    test.setTimeout(90_000);
    const account = await registerViaApi(request, "hand");
    await asDesktopApp(page, NODE);
    await page.goto("/login");
    await page.getByTestId("node-page-signin").click();
    await expect(page.getByTestId("handoff-waiting")).toBeVisible();
    const url = await openedConnectPage(page);
    await signInOnNodePage(browser, url, account);
    // The app polled the code, exchanged it with its verifier and closed the window; its own device sets up encryption.
    await expect(page.getByTestId("encryption-title")).toHaveText("Dein Wiederherstellungsschlüssel", { timeout: 20_000 });
    expect(await page.evaluate(() => sessionStorage.getItem("e2e.desktop.connect.closed"))).toBe("1");
    const token = await page.evaluate(() => JSON.parse(localStorage.getItem("tavrn.auth") ?? "{}").token as string);
    const devices = await (await request.get(`${NODE}/api/v1/users/me/devices`, { headers: { Authorization: `Bearer ${token}` } })).json();
    expect(devices.find((d: { current: boolean }) => d.current)?.name).toBe("Desktop app");
    // The waiting panel fits the phone width.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test("the browser has neither the picker nor Settings → App", async ({ page, request }) => {
    const account = await registerViaApi(request, "web");
    await loginAs(page, account);
    await page.goto("/settings/profile");
    await expect(page.getByRole("link", { name: "App", exact: true })).toHaveCount(0);
    // The browser has the hotkeys for its window; system-wide ones are the desktop app's.
    await page.goto("/settings/voice");
    await expect(page.getByTestId("more-hotkeys")).toBeVisible();
    await expect(page.getByText("die Desktop-App beobachtet sie auch systemweit")).toBeVisible();
  });
});

test.describe("Desktop app: hotkeys (simulated shell)", () => {
  const hotkeyLog = (page: Page) => page.evaluate(() => JSON.parse(sessionStorage.getItem("e2e.desktop.hotkeys") ?? "[]") as string[]);

  test("one binding per action: lone modifiers and plain keys, conflict check, restored at start, presses of the shell and of the window", async ({ page, request }) => {
    test.setTimeout(180_000);
    await asDesktopApp(page, NODE);
    await registerViaUi(page, { prefix: "hotk" });
    await page.goto("/settings/voice");
    const more = page.getByTestId("more-hotkeys");
    await expect(page.getByText("Weitere Tastenkürzel", { exact: true })).toBeVisible();
    await expect(more.getByTestId("hotkey-toggle_mute-key")).toHaveText("keins");
    // Signed in: the shell's key listener is switched on.
    await expect.poll(() => hotkeyLog(page)).toContain("enabled true");

    // Ctrl+Shift+M for mute: the platform's key names, the shell's canonical spelling.
    await more.getByTestId("hotkey-toggle_mute-change").click();
    await expect(more.getByTestId("hotkey-toggle_mute-key")).toHaveText("Taste oder Kombination drücken …");
    await page.keyboard.press("Control+Shift+KeyM");
    await expect(more.getByTestId("hotkey-toggle_mute-key")).toHaveText("Ctrl + Shift + M");
    expect(await hotkeyLog(page)).toContain("register toggle_mute Ctrl+Shift+KeyM");

    // The same binding for deafen is refused with a message; a plain key is fine (observed, not reserved).
    await more.getByTestId("hotkey-toggle_deafen-change").click();
    await page.keyboard.press("Control+Shift+KeyM");
    await expect(more.getByRole("alert")).toContainText("Stummschalten");
    await more.getByTestId("hotkey-toggle_deafen-change").click();
    await page.keyboard.press("KeyD");
    await expect(more.getByTestId("hotkey-toggle_deafen-key")).toHaveText("D");
    expect(await hotkeyLog(page)).toContain("register toggle_deafen KeyD");
    // Escape cancels, Backspace removes the binding.
    await more.getByTestId("hotkey-toggle_deafen-change").click();
    await page.keyboard.press("Escape");
    await expect(more.getByTestId("hotkey-toggle_deafen-key")).toHaveText("D");
    await more.getByTestId("hotkey-toggle_deafen-change").click();
    await page.keyboard.press("Backspace");
    await expect(more.getByTestId("hotkey-toggle_deafen-key")).toHaveText("keins");
    expect(await hotkeyLog(page)).toContain("unregister toggle_deafen");

    // Push-to-talk under "Input mode" is the one binding, in the window and system-wide: the left Ctrl alone.
    await page.getByTestId("mode-ptt").check();
    await page.getByTestId("ptt-capture").click();
    await page.keyboard.down("ControlLeft");
    await page.keyboard.up("ControlLeft");
    await expect(page.getByTestId("ptt-key")).toHaveText("Ctrl links");
    expect(await hotkeyLog(page)).toContain("register push_to_talk ControlLeft");
    // Another action's key is refused there too.
    await page.getByTestId("ptt-capture").click();
    await page.keyboard.press("Control+Shift+KeyM");
    await expect(page.getByTestId("ptt-settings").getByRole("alert")).toContainText("Stummschalten");
    await expect(page.getByTestId("ptt-key")).toHaveText("Ctrl links");
    // Holding the key lights it up (the window's key events).
    await page.keyboard.down("ControlLeft");
    await expect(page.getByTestId("ptt-key")).toHaveAttribute("data-held", "true");
    await page.keyboard.up("ControlLeft");
    await expect(page.getByTestId("ptt-key")).not.toHaveAttribute("data-held");
    // The phone layout keeps the page within the screen.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    // A new start hands the stored bindings to the shell again and switches its listener on.
    await page.evaluate(() => sessionStorage.setItem("e2e.desktop.hotkeys", "[]"));
    await page.reload();
    await expect(page.getByTestId("more-hotkeys").getByTestId("hotkey-toggle_mute-key")).toHaveText("Ctrl + Shift + M");
    await expect
      .poll(() => hotkeyLog(page))
      .toEqual(expect.arrayContaining(["register toggle_mute Ctrl+Shift+KeyM", "register push_to_talk ControlLeft", "unregister priority", "unregister toggle_deafen", "enabled true"]));

    // In a voice channel, with the window in the background, the shell's press toggles mute, the release does nothing.
    const room = await createRoomViaApi(request, await tokenOf(page), "Hotkeys");
    const voiceId = (room.channels as { id: string; kind: string }[]).find((c) => c.kind === "voice")!.id;
    await page.goto(`/rooms/${room.id}/channels/${voiceId}`);
    await page.getByTestId("voice-join").click();
    await expect(page.getByTestId("voice-e2ee")).toBeVisible({ timeout: 30_000 });
    const mute = page.getByTestId("voice-mute");
    await expect(mute).toHaveAttribute("aria-pressed", "false");
    const shell = (action: string, pressed: boolean) => page.evaluate(([a, p]) => (window as unknown as { __e2eHotkey: (a: string, p: boolean) => void }).__e2eHotkey(a as string, p as boolean), [action, pressed] as const);
    const focus = (on: boolean) => page.evaluate((f) => (document.hasFocus = () => f), on);
    await focus(false);
    await shell("toggle_mute", true);
    await expect(mute).toHaveAttribute("aria-pressed", "true");
    await shell("toggle_mute", false);
    await expect(mute).toHaveAttribute("aria-pressed", "true");
    await shell("toggle_mute", true);
    await expect(mute).toHaveAttribute("aria-pressed", "false");
    await shell("toggle_mute", false);
    // With the window in front its own key events act; the shell sees the same key and it still toggles once.
    await focus(true);
    await shell("toggle_mute", true);
    await page.keyboard.press("Control+Shift+KeyM");
    await shell("toggle_mute", false);
    await expect(mute).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Control+Shift+KeyM");
    await expect(mute).toHaveAttribute("aria-pressed", "false");
    // Push-to-talk (the left Ctrl alone): a rising tone when the microphone opens, a falling one when it closes.
    const pttTones = async () => (await cues(page)).filter((c) => c.cue === "ptt_on" || c.cue === "ptt_off").length;
    const before = await pttTones();
    await page.keyboard.down("ControlLeft");
    await page.waitForTimeout(150);
    await page.keyboard.up("ControlLeft");
    await expect.poll(pttTones).toBe(before + 2);
    expect((await cues(page)).slice(-2).map((c) => c.cue)).toEqual(["ptt_on", "ptt_off"]);
    await page.getByTestId("voice-leave").click();
  });
});
