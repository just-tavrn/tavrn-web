// SPDX-License-Identifier: Apache-2.0
// Shared helpers of the voice and call specs (tavrn-protocol/VOICE.md): browser contexts with Chromium's fake
// microphone and camera, the development hooks of the voice client and the notification sounds.
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
// With its extension: the Electron shell's smoke test (apps/desktop-electron, module resolution "nodenext") imports this file.
import { NODE, openNavIfMobile, registerViaUi, tokenOf, type UiAccount } from "./helpers.ts";
import { scaled } from "./timeouts.ts";

/** A short 16-bit mono WAV (a 440 Hz tone). */
export function toneWav(seconds = 0.5, rate = 16000): Buffer {
  const n = Math.floor(seconds * rate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000), 44 + i * 2);
  return buf;
}

// Fake microphone (a continuous tone from a file, so LiveKit counts it as speech) and camera, no
// permission prompts, audio without a user gesture.
const FAKE_TONE = join(tmpdir(), "tavrn-calls-e2e-tone.wav");
writeFileSync(FAKE_TONE, toneWav(5, 48000));
export const FAKE_MEDIA = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${FAKE_TONE}`, "--autoplay-policy=no-user-gesture-required"];

export interface VoiceUser {
  page: Page;
  address: string;
  username: string;
  /** Credentials, second factor and recovery key of the account (signing in again, unlocking). */
  account: UiAccount;
}

/** Contexts opened by a test; the spec closes them afterwards (each holds LiveKit ports of the node). */
export const opened: BrowserContext[] = [];

export async function closeOpened(): Promise<void> {
  for (const c of opened.splice(0)) await c.close().catch(() => undefined);
}

/** A new account (with encryption set up) in its own browser context with fake media. */
export async function voiceUser(browser: Browser, prefix: string, console?: string[]): Promise<VoiceUser> {
  const context = await browser.newContext({ ...test.info().project.use, permissions: ["microphone", "camera"] });
  opened.push(context);
  const page = await context.newPage();
  if (console) page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && console.push(`[${prefix}] ${m.type()}: ${m.text()}`));
  const account = await registerViaUi(page, { prefix });
  return { page, address: account.address, username: account.username, account };
}

/** `a` and `b` become friends (API). */
export async function befriend(a: VoiceUser, b: VoiceUser): Promise<void> {
  const resp = await a.page.request.post(`${NODE}/api/v1/users/me/friends/requests`, { headers: { Authorization: `Bearer ${await tokenOf(a.page)}` }, data: { user: b.username } });
  expect(resp.ok(), await resp.text()).toBeTruthy();
  const token = await tokenOf(b.page);
  const list = await (await b.page.request.get(`${NODE}/api/v1/users/me/friends`, { headers: { Authorization: `Bearer ${token}` } })).json();
  for (const r of list.incoming) await b.page.request.post(`${NODE}/api/v1/users/me/friends/requests/${r.id}/accept`, { headers: { Authorization: `Bearer ${token}` } });
}

export async function send(page: Page, text: string): Promise<void> {
  const box = page.getByLabel("Nachricht", { exact: true });
  await expect(box).toBeEnabled({ timeout: scaled(20_000) });
  await box.fill(text);
  await page.keyboard.press("Enter");
  await expect(box).toHaveValue("");
}

export const message = (page: Page, text: string) => page.getByTestId("message").filter({ hasText: text });

/** Opens a DM or group from the conversation list (the drawer on phones). */
export async function openConversation(page: Page, name: RegExp): Promise<void> {
  await page.goto("/");
  await openNavIfMobile(page);
  await page.getByTestId("dm-list").getByRole("link", { name }).click();
}

/** Notification sounds played so far (development builds record them, `cues.ts`). */
export const cues = (page: Page) => page.evaluate(() => (window as unknown as { __tavrnCues?: { played: { cue: string; own: boolean }[] } }).__tavrnCues?.played ?? []);

export interface HookState {
  e2eeEnabled: boolean;
  localEncrypted: boolean;
  /** The microphone capture is open (released a moment after a mute). */
  capturing?: boolean;
  remote: { identity: string; isSpeaking: boolean; isEncrypted: boolean; tracks: { source: string; encrypted: boolean; subscribed: boolean }[] }[];
}

/** LiveKit's view of the call (the hooks appear once the session finished connecting). */
export async function hooks(page: Page): Promise<HookState> {
  await expect.poll(() => page.evaluate(() => !!(window as unknown as { __tavrnVoice?: unknown }).__tavrnVoice), { timeout: scaled(30_000) }).toBe(true);
  return page.evaluate(() => (window as unknown as { __tavrnVoice: { state: () => unknown } }).__tavrnVoice.state() as HookState);
}

/** Peak of the decoded (and decrypted) audio of a remote participant over two seconds. */
export async function inboundPeak(page: Page, identity: string): Promise<number> {
  return page.evaluate(async (id) => (window as unknown as { __tavrnVoice: { inboundAudioPeak: (i: string) => Promise<number> } }).__tavrnVoice.inboundAudioPeak(id), identity);
}

/**
 * Init script: device names and ids stay hidden until the page asked for the microphone, as browsers do without
 * Chromium's test flags (which reveal them at once). `window.__e2eAsked` counts the requests.
 */
export function hideDeviceNamesUntilAsked() {
  const md = navigator.mediaDevices;
  const enumerate = md.enumerateDevices.bind(md);
  const gum = md.getUserMedia.bind(md);
  const w = window as unknown as { __e2eAsked: number };
  w.__e2eAsked = 0;
  md.getUserMedia = async (c?: MediaStreamConstraints) => {
    const stream = await gum(c);
    if (c?.audio) w.__e2eAsked += 1;
    return stream;
  };
  md.enumerateDevices = async () => {
    const all = await enumerate();
    if (w.__e2eAsked > 0) return all;
    const kinds = [...new Set(all.map((d) => d.kind))];
    return kinds.map((kind) => ({ kind, deviceId: "", groupId: "", label: "", toJSON: () => ({}) }) as MediaDeviceInfo);
  };
}
