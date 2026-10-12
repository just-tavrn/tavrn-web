// SPDX-License-Identifier: Apache-2.0
// Accessibility gate (design note 4.14 item 4, docs/ACCESSIBILITY.md): axe-core scans the main screens of the web
// client against WCAG 2.0/2.1/2.2 A and AA. Serious and critical WCAG violations fail the test; moderate and minor
// ones and the `best-practice` rules are logged (attached as JSON) but do not fail. `A11Y_REPORT_DIR=<dir>` also
// writes every finding of every scan there (the audit table of docs/ACCESSIBILITY.md is built from it), and
// `A11Y_REPORT_ONLY=1` turns the gate off (for taking a baseline).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { NODE, adminAccount, createRoomViaApi, inviteCode, loginAs, openNavIfMobile, registerViaApi, registerViaUi, tokenOf } from "./helpers";
import { openContextMenu, openMembers, postAttachment, postMessage } from "./menu-helpers";
import { scaled } from "./timeouts";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa", "best-practice"];
const FAILING = new Set(["serious", "critical"]);
// Fake microphone and camera (as voice.spec.ts) so the voice channel can be joined without prompts.
const FAKE_MEDIA = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"];
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

interface Finding {
  screen: string;
  rule: string;
  impact: string;
  wcag: boolean;
  help: string;
  nodes: number;
  targets: string[];
  /** axe's explanation for the first node. */
  summary?: string;
  /** color-contrast: the measured pairs (`fg on bg = ratio`), to find the design tokens behind them. */
  colors?: string[];
}

const findings: Finding[] = [];

/** Runs axe on the current page state and records the violations under `screen`. */
async function scan(page: Page, screen: string) {
  // Let transitions and lazy content settle (axe measures colors of what is painted).
  await page.waitForTimeout(400);
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  for (const v of result.violations) {
    findings.push({
      screen,
      rule: v.id,
      impact: v.impact ?? "minor",
      wcag: v.tags.some((t) => /^wcag\d/.test(t)),
      help: v.help,
      nodes: v.nodes.length,
      targets: v.nodes.slice(0, 6).map((n) => n.target.join(" ")),
      summary: v.nodes[0]?.failureSummary?.slice(0, 400),
      colors:
        v.id === "color-contrast"
          ? [...new Set(v.nodes.map((n) => n.any[0]?.data as { fgColor?: string; bgColor?: string; contrastRatio?: number } | undefined).map((d) => `${d?.fgColor} on ${d?.bgColor} = ${d?.contrastRatio}`))]
          : undefined,
    });
  }
}

test.use({ launchOptions: { args: FAKE_MEDIA }, permissions: ["microphone", "camera"] });

test.beforeEach(() => {
  findings.length = 0;
});

test.afterEach(async ({}, info: TestInfo) => {
  const body = JSON.stringify(findings, null, 2);
  await info.attach("axe-findings", { body, contentType: "application/json" });
  const dir = process.env.A11Y_REPORT_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    const name = `${info.project.name}-${info.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.json`;
    writeFileSync(join(dir, name), body);
  }
  const logged = findings.filter((f) => !(f.wcag && FAILING.has(f.impact)));
  if (logged.length) console.log(`[a11y] ${info.project.name} / ${info.title}: ${logged.length} non-blocking findings\n${logged.map((f) => `  ${f.impact} ${f.rule} (${f.nodes}) @ ${f.screen}`).join("\n")}`);
  if (process.env.A11Y_REPORT_ONLY) return;
  const blocking = findings.filter((f) => f.wcag && FAILING.has(f.impact));
  expect(blocking.map((f) => `${f.impact} ${f.rule} @ ${f.screen}: ${f.help} → ${f.targets.join(" | ")}`), "serious/critical WCAG violations").toEqual([]);
});

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const phone = (page: Page) => (page.viewportSize()?.width ?? 1280) < 768;

test.describe("Accessibility (axe, WCAG 2.2 AA)", () => {
  test("sign-in, registration, password reset, e-mail confirmation and invite pages", async ({ page, request }) => {
    const owner = await registerViaApi(request, "a11yinv");
    const room = await createRoomViaApi(request, owner.token, "Barrierefrei");
    const code = await inviteCode(request, owner.token, room.id);

    await page.goto("/login");
    await expect(page.getByRole("button", { name: "Anmelden", exact: true })).toBeVisible();
    await scan(page, "login");
    await expect(page.locator("html")).toHaveAttribute("lang", "de");
    // A failed sign-in shows its error next to the form.
    await page.getByLabel("Benutzername", { exact: true }).fill("niemand");
    await page.getByLabel("Passwort", { exact: true }).fill("falsches-passwort");
    await page.getByRole("button", { name: "Anmelden", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await scan(page, "login (error)");
    await page.getByRole("tab", { name: "Registrieren" }).click();
    await expect(page.getByLabel("Passwort wiederholen", { exact: true })).toBeVisible();
    await scan(page, "registration");

    await page.goto("/forgot-password");
    await scan(page, "forgot password");

    // The page of the confirmation mail's link: without a link, and with one that is invalid.
    await page.goto("/verify-email");
    await expect(page.getByRole("heading", { name: "E-Mail-Adresse bestätigen" })).toBeVisible();
    await scan(page, "verify e-mail");
    await page.goto("/verify-email?token=not-a-real-token");
    await expect(page.getByRole("heading", { name: "Link ungültig" })).toBeVisible();
    await scan(page, "verify e-mail (invalid link)");

    // The invite page of a signed-in user who is not a member yet (signed out it leads to the sign-in).
    const guest = await registerViaApi(request, "a11yg");
    await loginAs(page, guest);
    await page.goto(`/invite/${code}`);
    await expect(page.getByText("Barrierefrei").first()).toBeVisible();
    await scan(page, "invite");
  });

  test("room view, composer, pickers, menus, dialogs, settings and search", async ({ page, request }) => {
    test.setTimeout(scaled(180_000));
    const owner = await registerViaApi(request, "a11y");
    const member = await registerViaApi(request, "a11ym");
    const room = await createRoomViaApi(request, owner.token, "Lesbar", "public");
    const code = await inviteCode(request, owner.token, room.id);
    await request.post(`${NODE}/api/v1/invites/${code}/join`, { headers: auth(member.token), data: {} });
    const channel = room.channels.find((c: { kind: string }) => c.kind === "text") as { id: string };
    const files = await (await request.post(`${NODE}/api/v1/rooms/${room.id}/channels`, { headers: auth(owner.token), data: { kind: "files", name: "ablage", encrypted: false } })).json();
    const first = await postMessage(request, owner.token, channel.id, "Willkommen in **Lesbar**, schaut auf https://example.org");
    await postMessage(request, member.token, channel.id, "Danke!", { reply_to_id: first.id });
    await postMessage(request, owner.token, channel.id, "```rust\nfn main() { println!(\"hi\"); }\n```");
    await postAttachment(request, member.token, channel.id, { name: "pixel.png", mime: "image/png", buffer: PNG }, "Ein Bild");

    await loginAs(page, owner);
    await page.goto(`/rooms/${room.id}/channels/${channel.id}`);
    await expect(page.getByTestId("message").filter({ hasText: "Ein Bild" })).toBeVisible();
    await expect(page.getByTestId("message").filter({ hasText: "fn main" })).toBeVisible();
    await scan(page, "room: text channel with messages");

    if (phone(page)) {
      await openNavIfMobile(page);
      await scan(page, "navigation drawer (phone)");
      await page.keyboard.press("Escape");
      await page.goto(`/rooms/${room.id}/channels/${channel.id}`);
      await expect(page.getByTestId("message").filter({ hasText: "Ein Bild" })).toBeVisible();
    }

    // The room header's menu (one button: icon, name, chevron) and the account menu of the account bar.
    await openNavIfMobile(page);
    await page.getByTestId("room-header-menu").click();
    await expect(page.getByTestId("room-menu")).toBeVisible();
    await scan(page, "room header menu");
    // A state change keeps the menu and its submenu open (checkmarks re-rendered).
    await page.getByTestId("room-menu").getByRole("menuitem", { name: "Benachrichtigungen" }).click();
    await page.getByTestId("context-submenu").getByRole("menuitemcheckbox", { name: "Nur Erwähnungen" }).click();
    await expect(page.getByTestId("context-submenu").getByRole("menuitemcheckbox", { name: "Nur Erwähnungen" })).toHaveAttribute("aria-checked", "true");
    await scan(page, "room header menu: notifications after a change");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("room-menu")).toHaveCount(0);
    await page.getByTestId("presence-menu-button").click();
    await expect(page.getByTestId("presence-menu")).toBeVisible();
    await scan(page, "account menu");
    await page.keyboard.press("Escape");
    await page.goto(`/rooms/${room.id}/channels/${channel.id}`);
    await expect(page.getByTestId("message").filter({ hasText: "Ein Bild" })).toBeVisible();

    // Composer with the emoji picker.
    await expect(page.getByLabel("Nachricht", { exact: true })).toBeEnabled({ timeout: 20_000 });
    await page.getByRole("button", { name: "Emoji einfügen" }).click();
    await expect(page.getByTestId("emoji-picker").getByRole("group", { name: "Smileys & Emotionen" })).toBeVisible();
    await scan(page, "composer: emoji picker");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("emoji-picker")).toHaveCount(0);

    // Context menu of a message.
    await openContextMenu(page, page.getByTestId("message").filter({ hasText: "Danke!" }));
    await expect(page.getByTestId("message-menu")).toBeVisible();
    await scan(page, "message context menu");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("message-menu")).toHaveCount(0);

    // Media viewer.
    await page.getByTestId("message").filter({ hasText: "Ein Bild" }).getByTestId("attachment-image").locator("img").click();
    await expect(page.getByTestId("media-viewer")).toBeVisible();
    await scan(page, "media viewer");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("media-viewer")).toHaveCount(0);

    // Member list.
    await openMembers(page);
    await scan(page, "member list");
    await page.goto(`/rooms/${room.id}/channels/${channel.id}`);

    // A modal dialog: create channel.
    await openNavIfMobile(page);
    await page.getByRole("button", { name: "Channel erstellen" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await scan(page, "dialog: create channel");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // Search panel.
    await page.goto(`/rooms/${room.id}/channels/${channel.id}`);
    await page.getByTestId("search-open").click();
    await page.getByTestId("search-input").fill("Willkommen");
    await expect(page.getByTestId("search-panel")).toBeVisible();
    await page.waitForTimeout(800);
    await scan(page, "search panel");
    await page.keyboard.press("Escape");

    // Files channel.
    await page.goto(`/rooms/${room.id}/channels/${files.id}`);
    await expect(page.getByTestId("files-view")).toBeVisible();
    await page.getByTestId("files-upload-input").setInputFiles([{ name: "notiz.txt", mimeType: "text/plain", buffer: Buffer.from("Hallo") }, { name: "bild.png", mimeType: "image/png", buffer: PNG }]);
    await expect(page.getByTestId("files-list")).toContainText("notiz.txt");
    await scan(page, "files channel");

    // Room settings.
    for (const tab of ["overview", "profile", "roles", "channels", "members", "invites", "webhooks", "applications", "emojis", "soundboard", "moderation", "audit"]) {
      await page.goto(`/rooms/${room.id}/settings/${tab}`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await page.waitForLoadState("networkidle");
      await scan(page, `room settings: ${tab}`);
    }

    // User settings.
    for (const tab of ["profile", "privacy", "security", "voice", "notifications", "emojis", "sounds", "applications", "language", "devices"]) {
      await page.goto(`/settings/${tab}`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await page.waitForLoadState("networkidle");
      await scan(page, `user settings: ${tab}`);
    }

    await page.goto("/discover");
    await page.waitForLoadState("networkidle");
    await scan(page, "discover");

    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await scan(page, "home");

    // A link to a node the account has nothing on asks before signing in there.
    await page.goto("/n/unknown.example/rooms/01ARZ3NDEKTSV4RRFFQ69G5FAV");
    await expect(page.getByTestId("node-connect-confirm")).toBeVisible();
    await scan(page, "first sign-in on another node (confirmation)");
  });

  test("friends, direct messages and the voice channel", async ({ page, request }) => {
    test.setTimeout(scaled(180_000));
    // The voice channel and DMs need encryption keys: a full registration through the UI.
    const me = await registerViaUi(page, { prefix: "a11yv" });
    const friend = await registerViaApi(request, "a11yf");
    const token = await tokenOf(page);
    const req = await request.post(`${NODE}/api/v1/users/me/friends/requests`, { headers: auth(friend.token), data: { user: me.username } });
    expect(req.ok(), await req.text()).toBeTruthy();

    await page.goto("/friends");
    await expect(page.getByTestId("friends-incoming")).toContainText(friend.username);
    await scan(page, "friends (incoming request)");
    await page.getByTestId("friends-incoming").getByRole("button", { name: "Annehmen" }).click();
    await expect(page.getByTestId("friends-list")).toContainText(friend.username);
    await scan(page, "friends");

    await page.getByTestId("friends-list").locator("li").filter({ hasText: friend.username }).getByRole("button", { name: "Nachricht" }).click();
    await expect(page.getByTestId("conversation-name")).toHaveText(friend.username);
    await page.waitForLoadState("networkidle");
    await scan(page, "direct message");

    const room = await createRoomViaApi(request, token, "Stimmen", "invite", { encrypted: true });
    const text = room.channels.find((c: { kind: string }) => c.kind === "text") as { id: string };

    // The whiteboard: scanned, and Tab leaves the drawing canvas again (no keyboard trap, WCAG 2.1.2).
    await page.goto(`/rooms/${room.id}/channels/${text.id}`);
    await page.getByTestId("whiteboard-button").click();
    await page.getByRole("button", { name: "Whiteboard öffnen" }).click();
    await expect(page.getByTestId("whiteboard-board")).toHaveAttribute("data-role", "owner", { timeout: 30_000 });
    await scan(page, "whiteboard");
    const box = (await page.getByTestId("whiteboard-canvas").boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    let left = false;
    for (let i = 0; i < 80 && !left; i++) {
      await page.keyboard.press("Tab");
      left = await page.evaluate(() => {
        const el = document.activeElement;
        return !!el && el !== document.body && !el.closest('[data-testid="whiteboard-canvas"]');
      });
    }
    expect(left, "Tab leaves the whiteboard canvas").toBe(true);

    await page.goto(`/rooms/${room.id}`);
    await openNavIfMobile(page);
    await page.getByRole("link", { name: "Sprachkanal Sprache" }).click();
    await expect(page.getByTestId("voice-stage")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("voice-controls")).toBeVisible();
    await scan(page, "voice channel (joined)");
    await page.getByTestId("voice-mute").click();
    await scan(page, "voice channel (muted)");
    // The voice bar with the padlock in the signal bars and the account bar below it (in the drawer on phones).
    await openNavIfMobile(page);
    await expect(page.getByTestId("voice-bar-signal")).toBeVisible();
    await expect(page.getByTestId("voice-bar-signal")).toHaveAccessibleName(/^Verschlüsselt · Verbindung/);
    await scan(page, "voice bar and account bar");
  });

  test("keyboard: skip link, focus trap and return in dialogs, pickers and the media viewer", async ({ page, request }) => {
    test.skip(phone(page), "hardware keyboards are tested on the desktop and tablet layouts");
    const owner = await registerViaApi(request, "a11yk");
    const room = await createRoomViaApi(request, owner.token, "Tastatur");
    const channel = room.channels.find((c: { kind: string }) => c.kind === "text") as { id: string };
    await postAttachment(request, owner.token, channel.id, { name: "pixel.png", mime: "image/png", buffer: PNG }, "Ein Bild");
    await loginAs(page, owner);
    await page.goto(`/rooms/${room.id}/channels/${channel.id}`);
    await expect(page.getByTestId("message").filter({ hasText: "Ein Bild" })).toBeVisible();

    // The first Tab shows the skip link; it moves the focus to the message list.
    await page.keyboard.press("Tab");
    const skip = page.getByTestId("skip-link");
    await expect(skip).toBeFocused();
    await expect(skip).toHaveText("Zu den Nachrichten springen");
    await expect(skip).toBeInViewport();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("message-list")).toBeFocused();
    await expect(page.locator('[role="feed"] article').first()).toHaveAttribute("aria-posinset", "1");

    // A modal dialog keeps Tab inside, closes with Escape and gives the focus back to its opener.
    const create = page.getByRole("button", { name: "Channel erstellen" });
    await create.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press("Shift+Tab");
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(create).toBeFocused();

    // Emoji picker: opened from the keyboard, Escape closes it and the focus returns.
    const emoji = page.getByRole("button", { name: "Emoji einfügen" });
    await emoji.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("emoji-picker").getByRole("menuitem").first()).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("emoji-picker")).toHaveCount(0);
    await expect(emoji).toBeFocused();

    // Media viewer: Tab stays inside, Escape closes it.
    await page.getByTestId("message").filter({ hasText: "Ein Bild" }).getByTestId("attachment-image").locator("img").click();
    const viewer = page.getByTestId("media-viewer");
    await expect(viewer.getByTestId("viewer-close")).toBeFocused();
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Tab");
      expect(await viewer.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0);

    // New messages of others are announced politely; the setting mutes the announcements.
    const member = await registerViaApi(request, "a11ykm");
    await request.post(`${NODE}/api/v1/invites/${await inviteCode(request, owner.token, room.id)}/join`, { headers: auth(member.token), data: {} });
    const announcer = page.getByTestId("message-announcer");
    await expect(announcer).toHaveAttribute("aria-live", "polite");
    await postMessage(request, member.token, channel.id, "Hallo zusammen");
    await expect(announcer).toHaveText(/^Neue Nachricht von .+: Hallo zusammen$/);
    await page.goto("/settings/notifications");
    await page.getByTestId("announce-messages").uncheck();
    await page.goto(`/rooms/${room.id}/channels/${channel.id}`);
    await expect(page.getByTestId("message").filter({ hasText: "Hallo zusammen" })).toBeVisible();
    await postMessage(request, member.token, channel.id, "Noch eine");
    await expect(page.getByTestId("message").filter({ hasText: "Noch eine" })).toBeVisible();
    await expect(announcer).toHaveText("");

    // The language follows the chosen locale.
    await page.goto("/settings/language");
    await page.getByTestId("locale-switch").selectOption("en");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await page.getByTestId("locale-switch").selectOption("de");
    await expect(page.locator("html")).toHaveAttribute("lang", "de");
  });

  test("admin page", async ({ page, request }) => {
    // Nine admin tabs plus the account menu and the settings navigation: more than the default 30 s on phones.
    test.setTimeout(scaled(90_000));
    const admin = await adminAccount(request);
    await loginAs(page, admin);
    // The account menu of a node admin (with the node administration) and the settings navigation with its link.
    await page.goto("/");
    await openNavIfMobile(page);
    await page.getByTestId("presence-menu-button").click();
    await expect(page.getByTestId("presence-admin")).toBeVisible();
    await scan(page, "account menu (node admin)");
    await page.goto("/settings/profile");
    await expect(page.getByTestId("settings-admin-link")).toBeVisible();
    await scan(page, "user settings (node admin)");
    for (const tab of ["overview", "users", "invites", "bans", "entitlements", "tokens", "applications", "federation", "audit"]) {
      await page.goto(`/admin/${tab}`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await page.waitForLoadState("networkidle");
      await scan(page, `admin: ${tab}`);
    }
  });
});
