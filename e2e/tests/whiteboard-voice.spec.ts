// SPDX-License-Identifier: Apache-2.0
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { openNavIfMobile, registerViaUi, openRoomInvite } from "./helpers";
import { scaled } from "./timeouts";

// The whiteboard on the voice stage (design note 4.10 "presented like a stream, joined on demand"; docs/CLIENT.md
// "Streams are joined"): two people in a voice call with Chromium's fake media devices. The board is a tile of its own
// ("Whiteboard · <name>", Join whiteboard) while every camera tile stays as it is; joined from the tile (button,
// double-click) or the member list, left from the tile, the board's menu or the fullscreen controls; the presenter's
// hideable preview and "Whiteboard is open" bar; a board next to a screen share; one presents either a screen share
// or a board.

const FAKE_TONE = join(tmpdir(), "tavrn-whiteboard-e2e-tone.wav");
writeFileSync(FAKE_TONE, silentWav());
const FAKE_MEDIA = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${FAKE_TONE}`, "--autoplay-policy=no-user-gesture-required"];
test.use({ launchOptions: { args: FAKE_MEDIA }, permissions: ["microphone", "camera"] });

function silentWav(seconds = 1, rate = 16000): Buffer {
  const n = seconds * rate;
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
  return buf;
}

/** Headless Chromium has no screen: `getDisplayMedia` returns a canvas capture (as in voice.spec.ts). */
function fakeScreen() {
  navigator.mediaDevices.getDisplayMedia = async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const g = canvas.getContext("2d")!;
    setInterval(() => {
      g.fillStyle = `hsl(${Date.now() % 360} 60% 40%)`;
      g.fillRect(0, 0, canvas.width, canvas.height);
    }, 100);
    return canvas.captureStream(10);
  };
}

/** Records the Screen Orientation API's lock and unlock calls (headless Chromium refuses real locks). */
function recordOrientationLocks() {
  const w = window as unknown as { __locks: string[] };
  w.__locks = [];
  const o = screen.orientation as ScreenOrientation & { lock: (x: string) => Promise<void>; unlock: () => void };
  if (!o) return;
  o.lock = async (x: string) => {
    w.__locks.push(x);
  };
  o.unlock = () => {
    w.__locks.push("unlock");
  };
}

const locks = (page: Page) => page.evaluate(() => (window as unknown as { __locks?: string[] }).__locks ?? []);

/** axe on the stage: serious and critical WCAG violations fail. */
async function axeStage(page: Page) {
  const result = await new AxeBuilder({ page }).include('[data-testid="voice-stage"]').withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  const bad = result.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

const opened: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of opened.splice(0)) await c.close().catch(() => undefined);
});

interface Person {
  page: Page;
  address: string;
  dialogs: string[];
}

async function person(browser: Browser, prefix: string, displayName: string): Promise<Person> {
  const context = await browser.newContext({ ...test.info().project.use, permissions: ["microphone", "camera"] });
  opened.push(context);
  await context.addInitScript(fakeScreen);
  await context.addInitScript(recordOrientationLocks);
  await context.addInitScript(() => localStorage.setItem("tavrn.voice.settings", JSON.stringify({ cuesOff: true })));
  const page = await context.newPage();
  const dialogs: string[] = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    void d.accept();
  });
  const account = await registerViaUi(page, { prefix, displayName });
  return { page, address: account.address, dialogs };
}

async function joinVoice(page: Page, roomUrl: string) {
  await page.goto(roomUrl);
  await openNavIfMobile(page);
  await page.getByRole("link", { name: "Sprachkanal Sprache" }).click();
  await expect(page.getByTestId("voice-stage")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("voice-e2ee")).toBeVisible({ timeout: 30_000 });
}

const tile = (page: Page, address: string) => page.getByTestId("voice-tile").and(page.locator(`[data-user="${address}"]`));
const row = (page: Page, address: string) => page.getByTestId("voice-participant").and(page.locator(`[data-user="${address}"]`));
const board = (page: Page) => page.getByTestId("whiteboard-board");
const boardTile = (page: Page) => page.getByTestId("whiteboard-tile");
const streamTile = (page: Page, address: string) => page.getByTestId("screen-tile").and(page.locator(`[data-user="${address}"]`));

async function drawRectangle(page: Page, from: [number, number], to: [number, number]) {
  await page.getByTestId("toolbar-rectangle").click({ force: true });
  const box = (await page.getByTestId("whiteboard-canvas").boundingBox())!;
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 8 });
  await page.mouse.up();
}

/** Opens a board action: inline on wide screens, in the "⋯" menu on narrower ones. */
async function action(page: Page, name: string) {
  const inline = page.getByRole("button", { name, exact: true });
  if (await inline.isVisible()) return inline.click();
  await page.getByRole("button", { name: "Whiteboard-Menü" }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}

test.describe("Whiteboard on the voice stage", () => {
  test("a tile of its own like a stream: joined and left, camera tiles stay; next to a screen share; screen instead of whiteboard", async ({ browser }) => {
    const project = test.info().project.name;
    test.skip(project !== "chromium" && project !== "mobile-android", "voice runs in Chromium");
    test.setTimeout(scaled(420_000));
    const phone = (test.info().project.use.viewport?.width ?? 1280) < 768;
    const alice = await person(browser, "wbvalice", "Alice");
    await openNavIfMobile(alice.page);
    await alice.page.getByRole("button", { name: "Raum erstellen" }).click();
    await alice.page.getByRole("dialog").getByLabel("Name").fill("Raidstammtisch");
    await alice.page.getByRole("dialog").getByRole("button", { name: "Erstellen" }).click();
    await expect(alice.page.getByTestId("channel-name")).toHaveText("allgemein");
    const roomUrl = alice.page.url().replace(/\/channels\/.*$/, "");
    await openRoomInvite(alice.page);
    await alice.page.getByRole("button", { name: "Link erzeugen" }).click();
    const link = await alice.page.getByTestId("invite-link").inputValue();
    await alice.page.getByRole("button", { name: "Fertig" }).click();
    const bob = await person(browser, "wbvbob", "Bob");
    await bob.page.goto(link);
    await bob.page.getByRole("button", { name: "Beitreten" }).click();
    await expect(bob.page.getByTestId("channel-name")).toHaveText("allgemein");

    await joinVoice(alice.page, roomUrl);
    await joinVoice(bob.page, roomUrl);
    for (const p of [alice, bob]) {
      await expect(tile(p.page, alice.address)).toBeVisible({ timeout: 30_000 });
      await expect(tile(p.page, bob.address)).toBeVisible({ timeout: 30_000 });
    }
    // Alice's camera runs the whole time: her camera tile must stay as it is next to the board.
    await alice.page.getByTestId("voice-camera").click();
    await expect(tile(bob.page, alice.address).getByTestId("video-camera")).toBeVisible({ timeout: 30_000 });

    // Alice presents a board from the call controls: her preview tile with the board, and the "Whiteboard is open" bar.
    await alice.page.getByTestId("voice-whiteboard").click();
    const alicePreview = boardTile(alice.page);
    await expect(alicePreview).toHaveAttribute("data-state", "preview", { timeout: 20_000 });
    await expect(alicePreview.getByTestId("whiteboard-stage-tile")).toBeVisible({ timeout: 20_000 });
    await expect(alice.page.getByTestId("whiteboard-indicator")).toContainText("Whiteboard ist geöffnet");
    await expect(board(alice.page)).toHaveAttribute("data-role", "owner");
    await expect(tile(alice.page, alice.address)).toBeVisible();
    await alice.page.getByTestId("whiteboard-maximize").click();
    // Away from Excalidraw's property panel on the left (desktop); phones have no panel there.
    const [first, second]: Array<[[number, number], [number, number]]> = phone
      ? [[[60, 140], [200, 240]], [[220, 300], [340, 380]]]
      : [[[360, 160], [480, 260]], [[560, 160], [680, 260]]];
    await drawRectangle(alice.page, ...first!);
    await expect(board(alice.page)).toHaveAttribute("data-elements", "1");

    // Bob sees the board as its own tile: badge, "Whiteboard · Alice", the live thumbnail and "Join whiteboard";
    // Alice's camera tile is unchanged, the member list marks her with the board badge.
    const bobsBoard = boardTile(bob.page);
    await expect(bobsBoard).toHaveAttribute("data-state", "available", { timeout: 20_000 });
    await expect(bobsBoard.getByTestId("whiteboard-tile-title")).toHaveText("Whiteboard · Alice");
    await expect(bobsBoard.getByTestId("whiteboard-badge")).toBeVisible();
    await expect(bobsBoard.getByTestId("whiteboard-thumbnail")).toBeVisible({ timeout: 30_000 });
    await expect(tile(bob.page, alice.address).getByTestId("video-camera")).toBeVisible();
    await expect(tile(bob.page, alice.address).getByTestId("whiteboard-badge")).toHaveCount(0);
    await expect(row(bob.page, alice.address).getByTestId("whiteboard-owner-badge")).toBeAttached();
    await expect(row(bob.page, bob.address).getByTestId("whiteboard-owner-badge")).toHaveCount(0);
    await expect(bob.page.getByTestId("whiteboard-stage-tile")).toHaveCount(0);
    await axeStage(bob.page);

    // Joined from the tile: the board fills a large tile and follows Alice live; her camera tile stays.
    await bobsBoard.getByTestId("whiteboard-join").click();
    await expect(bobsBoard).toHaveAttribute("data-state", "joined", { timeout: 20_000 });
    await expect(bobsBoard.getByTestId("whiteboard-stage-tile")).toBeVisible({ timeout: 20_000 });
    await expect(board(bob.page)).toHaveAttribute("data-role", "viewer");
    await expect(board(bob.page)).toHaveAttribute("data-elements", "1", { timeout: 20_000 });
    await drawRectangle(alice.page, ...second!);
    await expect(board(bob.page)).toHaveAttribute("data-elements", "2", { timeout: 20_000 });
    await expect(tile(bob.page, alice.address).getByTestId("video-camera")).toBeVisible();
    await axeStage(bob.page);

    // Alice sees who joined: in the board header and in her bar.
    await expect(alice.page.getByTestId("whiteboard-role")).toContainText("1 schauen zu", { timeout: 20_000 });
    await alice.page.getByTestId("whiteboard-maximize").click();
    await expect(alice.page.getByTestId("whiteboard-indicator").getByTestId("whiteboard-joined-count")).toHaveText("1 beigetreten", { timeout: 20_000 });
    await expect(tile(alice.page, alice.address).getByTestId("video-camera")).toBeVisible();
    await axeStage(alice.page);
    // She hides her preview (the board keeps running for Bob) and brings it back from the bar.
    await alicePreview.getByTestId("whiteboard-preview-hide").click();
    await expect(alicePreview).toHaveCount(0);
    await expect(alice.page.getByTestId("whiteboard-indicator")).toBeVisible();
    await expect(board(bob.page)).toHaveAttribute("data-elements", "2");
    await alice.page.getByTestId("whiteboard-preview-toggle").click();
    await expect(alicePreview).toHaveAttribute("data-state", "preview");
    await expect(board(alice.page)).toHaveAttribute("data-elements", "2");

    // Leave whiteboard on the tile: back to the placeholder. A double-click on the tile joins again (like a stream),
    // the board's own menu leaves as well.
    await bobsBoard.getByTestId("whiteboard-leave").click();
    await expect(bobsBoard).toHaveAttribute("data-state", "available");
    await expect(bob.page.getByTestId("whiteboard-stage-tile")).toHaveCount(0);
    await bobsBoard.dblclick({ position: { x: 24, y: 48 } });
    await expect(bobsBoard).toHaveAttribute("data-state", "joined", { timeout: 20_000 });
    await expect(board(bob.page)).toHaveAttribute("data-elements", "2", { timeout: 20_000 });
    await action(bob.page, "Sitzung verlassen");
    await expect(bobsBoard).toHaveAttribute("data-state", "available");

    // From the member list: a double-click on Alice (the board badge next to her name) joins the board.
    await openNavIfMobile(bob.page);
    await row(bob.page, alice.address).dblclick();
    await expect(bobsBoard).toHaveAttribute("data-state", "joined", { timeout: 20_000 });
    await expect(board(bob.page)).toHaveAttribute("data-elements", "2", { timeout: 20_000 });

    // Fullscreen as with streams: on phones the wide board turns the screen to landscape; "Leave whiteboard" in the
    // fullscreen controls ends both.
    await bobsBoard.getByTestId("whiteboard-fullscreen").click();
    await expect.poll(() => bob.page.evaluate(() => document.fullscreenElement?.getAttribute("data-testid") ?? null)).toBe("whiteboard-tile");
    if (phone) await expect.poll(() => locks(bob.page)).toEqual(["landscape"]);
    else expect(await locks(bob.page)).toEqual([]);
    await bobsBoard.hover({ position: { x: 120, y: 160 } });
    await bobsBoard.getByTestId("fullscreen-controls").getByTestId("fullscreen-board-leave").click();
    await expect.poll(() => bob.page.evaluate(() => document.fullscreenElement)).toBeNull();
    await expect(bobsBoard).toHaveAttribute("data-state", "available");
    if (phone) expect(await locks(bob.page)).toEqual(["landscape", "unlock"]);

    // A whiteboard and a screen share side by side: Bob shares his screen while Alice's board is open.
    await bob.page.getByTestId("voice-screen").click();
    await bob.page.getByTestId("screen-share-start").click();
    await expect(bob.page.getByTestId("streaming-indicator")).toBeVisible({ timeout: 30_000 });
    await expect(bobsBoard).toHaveAttribute("data-state", "available");
    const bobsStream = streamTile(alice.page, bob.address);
    await expect(bobsStream).toHaveAttribute("data-state", "available", { timeout: 30_000 });
    await bobsStream.getByTestId("stream-join").click();
    await expect(bobsStream.getByTestId("video-screen")).toBeVisible({ timeout: 30_000 });
    await bobsStream.getByTestId("screen-focus").click();
    const large = alice.page.getByTestId("voice-large");
    await expect(large.getByTestId("whiteboard-tile")).toHaveAttribute("data-state", "preview");
    await expect(large.getByTestId("screen-tile")).toHaveAttribute("data-focused", "true");
    const boardBox = (await large.getByTestId("whiteboard-tile").boundingBox())!;
    const streamBox = (await large.getByTestId("screen-tile").boundingBox())!;
    // Side by side on wide screens, one above the other on phones; neither covers the other.
    if (phone) expect(streamBox.y).toBeGreaterThanOrEqual(boardBox.y + boardBox.height - 1);
    else expect(streamBox.x).toBeGreaterThanOrEqual(boardBox.x + boardBox.width - 1);
    await expect(tile(alice.page, alice.address)).toBeVisible();
    await axeStage(alice.page);
    await bob.page.getByTestId("stream-stop").click();
    await expect(bobsStream).toHaveCount(0, { timeout: 15_000 });

    // One presentation at a time: sharing the screen asks, then closes the board for everyone.
    await alice.page.getByTestId("voice-screen").click();
    await expect.poll(() => alice.dialogs.join("\n")).toContain("Whiteboard schließen und Bildschirm teilen?");
    await alice.page.getByTestId("screen-share-start").click();
    await expect(alicePreview).toHaveCount(0, { timeout: 20_000 });
    await expect(alice.page.getByTestId("whiteboard-indicator")).toHaveCount(0);
    await expect(bobsBoard).toHaveCount(0, { timeout: 20_000 });
    await expect(row(bob.page, alice.address).getByTestId("whiteboard-owner-badge")).toHaveCount(0);
    await expect(streamTile(bob.page, alice.address)).toBeVisible({ timeout: 30_000 });
  });
});
