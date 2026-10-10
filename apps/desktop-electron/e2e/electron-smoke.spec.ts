// SPDX-License-Identifier: Apache-2.0
/**
 * The full smoke test of the Electron shell (docs/DESKTOP.md "The Linux shell (Electron)", the Tauri shell's
 * `apps/desktop/e2e/smoke.mjs` for the Linux app): the development build through Playwright's Electron driver, or a
 * package (`E2E_ELECTRON_APP`, the `.AppImage` in CI) over the DevTools protocol (`launch.ts`). One account signs in in
 * the app, a second one uses the web client in Chromium on the same node (voice on: livekit-server on the PATH):
 *
 *  1. node picker: the development node's URL (plain http on this computer), the login page;
 *  2. sign-in with TOTP on the node's page in the sign-in window, the recovery key set up in the app;
 *  3. an end-to-end encrypted message in both directions (the node stores ciphertext only);
 *  4. an encrypted image, opened in the media viewer;
 *  5. voice with the browser engine (Chromium's fake microphone): the other side sees the app's tile speaking;
 *  6. the camera (Chromium's fake camera): the other side sees the video;
 *  7. a screen share through the shell's own picker (the axe gate on the picker window, the first source chosen): the
 *     other side sees the share;
 *  8. the system-wide hotkey: push-to-talk bound to the left Ctrl alone, the app's window without focus (the other
 *     user's Chromium window has it), real key presses of the X server (xdotool) open and close the microphone, seen
 *     on the other side;
 *  9. close to tray (the call stays) and restore by starting the app again;
 * 10. quit from the shell.
 *
 * Screenshots of the main steps land in `test-results/`; the steps' timings are printed and attached. Always under
 * `xvfb-run -a` (just electron-e2e): the other user's Chromium opens a window too, and the key presses go to the X
 * server. Everything runs sandboxed (`launch.ts`; the other user's Chromium too). `E2E_ELECTRON_PARTIAL=1` lets the
 * steps whose part of the shell this build lacks (the sign-in window, the picker, the tray) be skipped with a note
 * instead of failing: for branches that carry only some parts of the shell (without the sign-in window the account
 * signs in with password and TOTP in the app's own form).
 */
import { execFileSync } from "node:child_process";
import { AxeBuilder } from "@axe-core/playwright";
import { chromium, expect, test, type Browser, type BrowserServer, type Page, type TestInfo } from "@playwright/test";
import { createRoomViaApi, inviteCode, nextTotpCode, registerViaApi, registerViaUi, tokenOf, type Account } from "../../../e2e/tests/helpers.ts";
import { FAKE_MEDIA } from "../../../e2e/tests/voice-helpers.ts";
import { nodeUrl } from "./harness.ts";
import { startSmokeApp, type SmokeApp } from "./launch.ts";

const PARTIAL = process.env.E2E_ELECTRON_PARTIAL === "1";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const A11Y_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];
/** The app gets Chromium's fake devices but never the fake permission UI: the shell's own handlers decide. */
const APP_MEDIA = FAKE_MEDIA.filter((a) => a !== "--use-fake-ui-for-media-stream");

let app: SmokeApp | null = null;
let server: BrowserServer | null = null;
let other: Browser | null = null;

test.beforeAll(() => {
  // The other user's Chromium opens a real window and xdotool types into the X server: never on a desktop's display.
  if (!/xvfb-run/.test(process.env.XAUTHORITY ?? "") && process.env.E2E_ALLOW_DISPLAY !== "1") {
    throw new Error("run the smoke test under xvfb-run -a (just electron-e2e); E2E_ALLOW_DISPLAY=1 for another dedicated X server");
  }
});

test.afterAll(async () => {
  await other?.close().catch(() => undefined);
  await server?.close().catch(() => undefined);
  await app?.close();
});

/** A step with its duration, for the summary at the end. */
const timings: { step: string; ms: number; note?: string }[] = [];
/** A note for the summary line of the running step. */
let stepNote: string | undefined;
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  stepNote = undefined;
  try {
    return await test.step(name, fn);
  } finally {
    timings.push({ step: name, ms: Date.now() - start, note: stepNote });
  }
}

/** A part of the shell this build lacks: a failure, unless E2E_ELECTRON_PARTIAL=1 (then noted and skipped). */
function lacking(what: string): void {
  if (!PARTIAL) throw new Error(`${what} (set E2E_ELECTRON_PARTIAL=1 for a build without this part of the shell)`);
  test.info().annotations.push({ type: "skipped step", description: what });
  stepNote = `skipped: ${what}`;
  console.log(`electron smoke: skipped: ${what}`);
}

async function shot(page: Page, info: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: info.outputPath(`${String(timings.length + 1).padStart(2, "0")}-${name}.png`) }).catch(() => undefined);
}

/** A method of the bridge, called from the page as the client calls it: the value, or the refusal as `{ refused }`. */
function bridge(page: Page, ns: string, method: string, ...args: unknown[]): Promise<{ value?: unknown; refused?: string }> {
  return page.evaluate(
    async ([ns, method, args]) => {
      const shell = (window as unknown as { tavrnShell: Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>> }).tavrnShell;
      try {
        return { value: await shell[ns as string]![method as string]!(...(args as unknown[])) };
      } catch (e) {
        return { refused: e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e) };
      }
    },
    [ns, method, args] as const,
  );
}
const notImplemented = (r: { refused?: string }) => !!r.refused?.startsWith("not implemented");

/** Client-side navigation (keeps the voice session). */
const navigate = (page: Page, path: string) =>
  page.evaluate((p) => {
    history.pushState({}, "", p);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);

const tile = (page: Page, address: string) => page.getByTestId("voice-tile").and(page.locator(`[data-user="${address}"]`));

/** Visible X windows found by xdotool (`search` arguments). */
function xwindows(args: string[]): string[] {
  try {
    return execFileSync("xdotool", ["search", "--onlyvisible", ...args], { encoding: "utf8" }).split(/\s+/).filter(Boolean);
  } catch {
    return [];
  }
}
/** The windows of a process (its `_NET_WM_PID`). */
const windowsOf = (pid: number) => xwindows(["--pid", String(pid)]);
/** The windows whose title matches (the app's window is always "tavrn"). */
const windowsNamed = (pattern: string) => xwindows(["--name", pattern]);

test("the Linux app end to end: picker, sign-in, encrypted chat, media, voice, camera, screen share, hotkey, tray, quit", async ({ request }, info) => {
  test.setTimeout(15 * 60_000);
  const started = Date.now();

  // The account of the app, registered over the API with TOTP (another device of the same user).
  const account: Account = await registerViaApi(request, "electron");
  const appAddress = `${account.username}@localhost`;

  app = await step("start the app", () => startSmokeApp(APP_MEDIA));
  const { page } = app;
  console.log(`electron smoke: ${app.mode} build`);

  await step("node picker: the development node's URL", async () => {
    await expect(page).toHaveURL(/^app:\/\/tavrn\//);
    await expect(page.locator('input[name="address"]')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId("node-picker-advanced").click();
    const url = page.locator('input[name="node"]');
    await url.fill(nodeUrl);
    await url.press("Enter");
    await expect(page).toHaveURL("app://tavrn/login", { timeout: 30_000 });
    await shot(page, info, "login");
  });

  await step("sign-in with TOTP on the node's page, recovery key in the app", async () => {
    // A build without the sign-in window answers "not implemented" (closeConnect does nothing when no window is open).
    const passwordAndTotp = async (form: Page) => {
      await form.locator('input[name="username"]').fill(account.username);
      await form.locator('input[name="password"]').fill(account.password);
      await form.locator('form button[type="submit"]').first().click();
      await form.locator('input[name="totp_code"]').fill(await nextTotpCode(account));
      await form.locator('form button[type="submit"]').first().click();
    };
    if (notImplemented(await bridge(page, "shell", "closeConnect"))) {
      lacking("the sign-in window (openConnect): password and TOTP in the app's own form instead");
      await passwordAndTotp(page);
    } else {
      const opened = app!.nextWindow(30_000);
      await page.getByTestId("node-page-signin").click();
      await expect(page.getByTestId("handoff-waiting")).toBeVisible();
      const connect = await opened;
      if (!connect) throw new Error("the sign-in window did not open");
      // The node's own page (its sign-in first, then the confirmation of the app session), without any bridge.
      await expect(connect).toHaveURL(new RegExp(`^(${nodeUrl}|http://localhost:\\d+)/`));
      expect(await connect.evaluate(() => typeof (window as unknown as { tavrnShell?: unknown }).tavrnShell)).toBe("undefined");
      await passwordAndTotp(connect);
      await connect.getByTestId("connect-allow").click();
      await expect(connect.getByTestId("connect-done")).toBeVisible({ timeout: 30_000 });
      // The sign-in window closes after the handoff.
      await expect.poll(() => app!.windows().length, { timeout: 30_000 }).toBe(1);
    }

    // The app exchanged the code; encryption is set up in the app (the recovery key from the encryption core).
    await expect(page.getByTestId("recovery-key-words")).toBeVisible({ timeout: 60_000 });
    await shot(page, info, "recovery-key");
    await page.locator('input[type="checkbox"]').check();
    await page.locator("xpath=//input[@type='checkbox']/ancestor::label/following-sibling::button[1]").click();
    await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 60_000 });
    // The sign-in window closes after the handoff.
  });

  // The room: its default text channel is encrypted; the other user joins with an invite.
  const room = await createRoomViaApi(request, account.token, "Electron smoke", "invite", { encrypted: true });
  const channels = room.channels as { id: string; kind: string }[];
  const textId = channels.find((c) => c.kind === "text")!.id;
  const voiceId = channels.find((c) => c.kind === "voice")!.id;
  const composer = page.locator('[data-testid="composer"] textarea:not([aria-hidden])');
  const sendFromApp = async (text: string) => {
    await composer.fill(text);
    await composer.press("Enter");
    await expect(page.getByTestId("message").filter({ hasText: text })).toBeVisible({ timeout: 30_000 });
  };

  const bob = await step("encrypted message round trip with a second user", async () => {
    await navigate(page, `/rooms/${room.id}/channels/${textId}`);
    await expect(composer).toBeEnabled({ timeout: 30_000 });
    await sendFromApp("Before Bob joined");
    const bobPage = await (await otherBrowser()).newPage();
    const bobAccount = await registerViaUi(bobPage, { prefix: "ebob" });
    const code = await inviteCode(request, account.token, room.id);
    const join = await request.post(`${nodeUrl}/api/v1/invites/${code}/join`, { headers: { Authorization: `Bearer ${await tokenOf(bobPage)}` }, data: {} });
    expect(join.ok(), await join.text()).toBeTruthy();
    await bobPage.goto(`/rooms/${room.id}/channels/${textId}`);
    const bobBox = bobPage.getByLabel("Nachricht", { exact: true });
    await expect(bobBox).toBeEnabled({ timeout: 30_000 });
    await bobBox.fill("Hallo von Bob");
    await bobPage.keyboard.press("Enter");
    await expect(page.getByTestId("message").filter({ hasText: "Hallo von Bob" })).toBeVisible({ timeout: 60_000 });
    await sendFromApp("Welcome from the Linux app");
    await expect(bobPage.getByTestId("message").filter({ hasText: "Welcome from the Linux app" })).toBeVisible({ timeout: 60_000 });
    const stored = await (await request.get(`${nodeUrl}/api/v1/conversations/${textId}/messages`, { headers: { Authorization: `Bearer ${account.token}` } })).json();
    expect(JSON.stringify(stored)).not.toContain("Welcome from the Linux app");
    expect((stored as { encrypted: boolean; author: string }[]).some((m) => m.encrypted && m.author === appAddress)).toBe(true);
    await shot(page, info, "encrypted-chat");
    return { page: bobPage, address: bobAccount.address };
  });

  await step("encrypted image in the media viewer", async () => {
    await page.locator('[data-testid="composer"] [data-testid="file-input"]').setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: PNG });
    await expect(page.getByTestId("pending-uploads")).toContainText("pixel.png", { timeout: 30_000 });
    await composer.fill("An image");
    await expect(page.locator('[data-testid="pending-uploads"] li:not(.text-danger) button').first()).toBeVisible({ timeout: 30_000 });
    await composer.press("Enter");
    const image = page.getByTestId("message").filter({ hasText: "An image" }).getByTestId("attachment-image").locator("img");
    await expect(image).toBeVisible({ timeout: 30_000 });
    await expect(bob.page.getByTestId("message").filter({ hasText: "An image" }).getByTestId("attachment-image").locator("img")).toBeVisible({ timeout: 60_000 });
    await image.click();
    const viewer = page.getByTestId("media-viewer");
    await expect(viewer.getByTestId("viewer-image")).toBeVisible();
    await shot(page, info, "media-viewer");
    await page.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0);
  });

  await step("voice with the browser engine: the other side sees the app speaking", async () => {
    await navigate(page, `/rooms/${room.id}/channels/${voiceId}`);
    await page.getByTestId("voice-join").click();
    await expect(page.getByTestId("voice-e2ee")).toBeVisible({ timeout: 45_000 });
    await bob.page.goto(`/rooms/${room.id}/channels/${voiceId}`);
    await bob.page.getByTestId("voice-join").click();
    await expect(bob.page.getByTestId("voice-e2ee")).toBeVisible({ timeout: 45_000 });
    await expect(tile(bob.page, appAddress)).toHaveAttribute("data-speaking", "true", { timeout: 45_000 });
    await expect(tile(page, bob.address)).toBeVisible();
    await shot(page, info, "voice");
  });

  await step("camera: the other side sees the app's video", async () => {
    await page.getByTestId("voice-camera").click();
    await expect(tile(bob.page, appAddress).getByTestId("video-camera")).toBeVisible({ timeout: 45_000 });
    await shot(bob.page, info, "camera-on-the-other-side");
    await page.getByTestId("voice-camera").click();
    await expect(tile(bob.page, appAddress).getByTestId("video-camera")).toHaveCount(0, { timeout: 30_000 });
  });

  await step("screen share through the shell's picker", async () => {
    const picked = app!.nextWindow(20_000);
    await page.getByTestId("voice-screen").click();
    await page.getByTestId("screen-share-start").click();
    const picker = await picked;
    if (!picker) {
      lacking("the screen-share picker (setDisplayMediaRequestHandler) did not open a window");
      return;
    }
    await picker.waitForLoadState();
    await shot(picker, info, "screen-picker");
    // The axe gate (WCAG 2.2 AA, serious and critical findings fail, as e2e/tests/a11y.spec.ts).
    const scan = await new AxeBuilder({ page: picker }).withTags(A11Y_TAGS).analyze();
    const failing = scan.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    await info.attach("axe-screen-picker.json", { body: JSON.stringify(scan.violations, null, 2), contentType: "application/json" });
    expect(failing.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(", ")})`)).toEqual([]);
    await chooseFirstSource(picker);
    const share = bob.page.getByTestId("screen-tile").and(bob.page.locator(`[data-user="${appAddress}"]`));
    await expect(share).toBeVisible({ timeout: 45_000 });
    await expect.poll(() => share.locator("video").evaluate((v) => (v as HTMLVideoElement).videoWidth).catch(() => 0), { timeout: 30_000 }).toBeGreaterThan(0);
    await shot(bob.page, info, "screen-share-on-the-other-side");
  });

  await step("system-wide push-to-talk on the left Ctrl, pressed through the X server while another window has the focus", async () => {
    await navigate(page, "/settings/voice");
    await page.getByTestId("mode-ptt").check();
    await page.getByTestId("ptt-capture").click();
    await page.keyboard.down("ControlLeft");
    await page.keyboard.up("ControlLeft");
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("tavrn.voice.settings") ?? "{}").hotkeys?.push_to_talk)).toBe("ControlLeft");
    // The shell took the binding and its key listener runs (otherwise Settings says the keys work in the window only).
    await expect(page.getByTestId("hotkeys-unavailable")).toHaveCount(0);
    await shot(page, info, "hotkey-settings");
    // Back on the voice channel: its push-to-talk button lights up while the microphone transmits.
    await navigate(page, `/rooms/${room.id}/channels/${voiceId}`);
    const transmitting = page.getByTestId("voice-ptt");
    await expect(transmitting).toBeVisible();
    await expect(transmitting).not.toHaveClass(/bg-accent/, { timeout: 15_000 });
    await expect(tile(bob.page, appAddress)).not.toHaveAttribute("data-speaking", "true", { timeout: 30_000 });
    // The other user's Chromium window takes the focus: the app's page no longer gets the keys itself. Playwright
    // emulates the focus of the pages it drives: switched off for this page, and the X focus goes to the app's window
    // first and then away (as a user switching to a game does).
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
    const appWindows = windowsNamed("^tavrn$");
    const others = windowsOf(otherPid());
    expect(appWindows.length, "the app's window on the X display").toBeGreaterThan(0);
    expect(others.length, "a visible window of the other user's Chromium").toBeGreaterThan(0);
    execFileSync("xdotool", ["windowfocus", "--sync", appWindows[0]!]);
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
    execFileSync("xdotool", ["windowfocus", "--sync", others[0]!]);
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
    // Every key event the page itself receives from now on is counted: the global path must not need any. (No
    // Playwright input or screenshot on the app's page from here on: either would make it believe it has the focus.)
    await page.evaluate(() => {
      const w = window as unknown as { __e2eKeys: number };
      w.__e2eKeys = 0;
      for (const type of ["keydown", "keyup"]) window.addEventListener(type, () => void (w.__e2eKeys += 1), { capture: true });
    });
    execFileSync("xdotool", ["keydown", "Control_L"]);
    let heard = false;
    try {
      await expect(transmitting).toHaveClass(/bg-accent/, { timeout: 10_000 });
      // The other side's speaking light after the gate reopened is noted, not required: it stays dark in some runs
      // although the app transmits (a voice matter, not the shell's: tavrn-web issue #47).
      heard = await expect(tile(bob.page, appAddress)).toHaveAttribute("data-speaking", "true", { timeout: 15_000 }).then(
        () => true,
        () => false,
      );
    } finally {
      execFileSync("xdotool", ["keyup", "Control_L"]);
    }
    await expect(transmitting).not.toHaveClass(/bg-accent/, { timeout: 10_000 });
    await expect(tile(bob.page, appAddress)).not.toHaveAttribute("data-speaking", "true", { timeout: 30_000 });
    const note = heard ? "the other side saw the app speaking" : "the other side's speaking light stayed dark";
    info.annotations.push({ type: "push-to-talk", description: note });
    stepNote = note;
    expect(await page.evaluate(() => (window as unknown as { __e2eKeys: number }).__e2eKeys), "key events the app's page received itself").toBe(0);
  });

  await step("close to tray (the call stays) and restore with a second start", async () => {
    const tray = await bridge(page, "tray", "trayStatus");
    if (notImplemented(tray)) {
      lacking("the tray (trayStatus)");
      return;
    }
    expect((tray.value as { close_to_tray: boolean }).close_to_tray, JSON.stringify(tray)).toBe(true);
    await page.evaluate(() => window.close());
    await expect.poll(() => page.evaluate(() => document.visibilityState), { timeout: 15_000 }).toBe("hidden");
    await expect(tile(bob.page, appAddress)).toBeVisible();
    expect(await app!.secondStart(), "the second start hands over and exits").toBe(0);
    await expect.poll(() => page.evaluate(() => document.visibilityState), { timeout: 15_000 }).toBe("visible");
    await shot(page, info, "restored");
  });

  await step("quit from the shell", async () => {
    // The app may quit before the call answers: no answer within 3 s counts as gone.
    const quit = await Promise.race([bridge(page, "tray", "quitApp").catch(() => ({})), new Promise<{ refused?: string }>((r) => setTimeout(() => r({}), 3000))]);
    if (notImplemented(quit)) {
      lacking("quitApp");
      await app!.close();
    }
    expect(await app!.exited(20_000), "the app exited").toBe(true);
    app = null;
  });

  const total = Date.now() - started;
  const table = [...timings.map((t) => `${(t.ms / 1000).toFixed(1).padStart(6)} s  ${t.step}${t.note ? `  (${t.note})` : ""}`), `${(total / 1000).toFixed(1).padStart(6)} s  total`].join("\n");
  console.log(`electron smoke timings:\n${table}`);
  await info.attach("timings.txt", { body: table, contentType: "text/plain" });
});

/** The other user's Chromium (a window on the X display, Chromium's fake devices), started once. */
async function otherBrowser() {
  if (!other) {
    // Sandboxed like the app (Playwright would otherwise switch Chromium's sandbox off).
    server = await chromium.launchServer({ headless: false, chromiumSandbox: true, args: [...FAKE_MEDIA, "--window-size=1100,800"] });
    other = await chromium.connect(server.wsEndpoint());
  }
  if (!contextOf) {
    contextOf = await other.newContext({ baseURL: nodeUrl, locale: "de-DE", viewport: { width: 1100, height: 760 }, permissions: ["microphone", "camera"] });
  }
  return contextOf;
}
let contextOf: Awaited<ReturnType<Browser["newContext"]>> | null = null;
const otherPid = () => server!.process().pid!;

/**
 * Picks the first source in the shell's screen-share picker: a source item (`data-testid="screen-source"`, else the first
 * option or radio), then its confirmation when the picker asks for one.
 */
async function chooseFirstSource(picker: Page): Promise<void> {
  const candidates = [picker.getByTestId("screen-source"), picker.getByRole("option"), picker.getByRole("radio"), picker.getByRole("listitem").getByRole("button")];
  let chosen = false;
  for (const c of candidates) {
    if ((await c.count()) > 0) {
      await c.first().click();
      chosen = true;
      break;
    }
  }
  if (!chosen) throw new Error("the picker shows no source (data-testid=screen-source, option, radio)");
  const confirm = picker.getByTestId("screen-source-share");
  if (!picker.isClosed() && (await confirm.count().catch(() => 0)) > 0) await confirm.click();
}
