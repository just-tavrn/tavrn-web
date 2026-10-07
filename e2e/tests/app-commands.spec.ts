// SPDX-License-Identifier: Apache-2.0
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { Client, MasterSecret } from "@tavrn/crypto";
import { CommandArgsVerifier, ensureCrypto } from "@tavrn/e2ee";
import { NODE, createRoomViaApi, loginAs, registerViaApi, registerViaUi, tokenOf, uniqueName, type Account } from "./helpers";

// Application commands, phase 5 step 3 (tavrn-protocol/APPLICATIONS.md §5): the `/` palette with an installed bot's
// commands, a pick-list argument, the bot's reply, an ephemeral reply and "thinking…" for a deferred one, in an
// unencrypted and an encrypted channel, and the per-room command settings. The bot side is a small WebSocket
// client in the test process that answers invocations with its app token.

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const SEND_MESSAGES = 1n << 1n;
const DOMAIN = "localhost";
const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const unb64url = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));

const COMMANDS = [
  {
    name: "weather",
    description: "Forecast for a city",
    args: [
      { name: "city", description: "City name", type: "string", required: true, max_length: 100 },
      { name: "units", description: "Unit system", type: "string", options: [{ name: "Metric", value: "metric" }, { name: "Imperial", value: "imperial" }] },
    ],
  },
  { name: "secret", description: "Tells you a secret" },
  { name: "slow", description: "Takes its time" },
];

interface App {
  id: string;
  ref: string;
  name: string;
  botAddress: string;
  secret: string;
  deviceId: string;
}

/** An application of `owner` with one token (all scopes) and the command set above. */
async function createApp(request: APIRequestContext, owner: Account): Promise<App> {
  const name = uniqueName("Wetter");
  const created = await request.post(`${NODE}/api/v1/applications`, { headers: auth(owner.token), data: { name, public: true, requested_permissions: SEND_MESSAGES.toString() } });
  expect(created.status(), await created.text()).toBe(201);
  const app = await created.json();
  const token = await request.post(`${NODE}/api/v1/applications/${app.id}/tokens`, { headers: auth(owner.token), data: { name: "main" } });
  expect(token.status(), await token.text()).toBe(201);
  const t = await token.json();
  const commands = await request.put(`${NODE}/api/v1/applications/${app.id}/commands`, { headers: auth(owner.token), data: { commands: COMMANDS } });
  expect(commands.status(), await commands.text()).toBe(200);
  return { id: app.id, ref: `${DOMAIN}/${app.id}`, name, botAddress: app.bot.address, secret: t.secret, deviceId: t.token.device_id };
}

async function install(request: APIRequestContext, token: string, roomId: string, app: App) {
  const resp = await request.post(`${NODE}/api/v1/rooms/${roomId}/applications`, { headers: auth(token), data: { application: app.ref, permissions: SEND_MESSAGES.toString() } });
  expect(resp.status(), await resp.text()).toBe(201);
}

interface Invocation {
  interaction_id: string;
  command: { id: string; name: string };
  conversation_id: string;
  encrypted: boolean;
  user: string;
  device_id: string;
  args: Record<string, unknown> | null;
  args_ciphertext: string | null;
  epoch: number | null;
}

type Answer = { content: unknown; epoch?: number };

/**
 * The bot: a WebSocket with its app token that answers `command.invoke`. `seal` turns a content object into what
 * the conversation needs (the object itself, or ciphertext of the bot's device); `open` returns the arguments.
 */
class TestBot {
  private ws!: WebSocket;
  readonly errors: string[] = [];
  readonly seen: Invocation[] = [];

  constructor(
    private readonly app: App,
    private readonly seal: (conversationId: string, content: Record<string, unknown>) => Promise<Answer>,
    private readonly open: (inv: Invocation) => Promise<Record<string, unknown>>,
  ) {}

  async connect(): Promise<void> {
    this.ws = new WebSocket(`${NODE.replace(/^http/, "ws")}/api/v1/ws`);
    await new Promise<void>((resolve, reject) => {
      this.ws.onerror = () => reject(new Error("bot socket failed"));
      this.ws.onopen = () => this.ws.send(JSON.stringify({ op: "hello", token: this.app.secret, capabilities: ["commands.v1"] }));
      this.ws.onmessage = (e) => {
        const frame = JSON.parse(String(e.data));
        if (frame.op === "ready") resolve();
        if (frame.op === "ping") this.ws.send(JSON.stringify({ op: "pong" }));
        if (frame.op === "event" && frame.type === "command.invoke") void this.handle(frame.data as Invocation).catch((err: unknown) => this.errors.push(String(err)));
      };
    });
  }

  close() {
    this.ws?.close();
  }

  private async call(path: string, body: unknown) {
    const resp = await fetch(`${NODE}/api/v1${path}`, { method: "POST", headers: { ...auth(this.app.secret), "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!resp.ok) throw new Error(`${path}: ${resp.status} ${await resp.text()}`);
  }

  private async handle(inv: Invocation) {
    this.seen.push(inv);
    const id = inv.interaction_id;
    const args = await this.open(inv);
    const text = async (body: string) => this.seal(inv.conversation_id, { type: "text", body });
    switch (inv.command.name) {
      case "weather":
        return this.call(`/interactions/${id}/callback`, { type: "reply", ...(await text(`${String(args.city)}: sunny (${String(args.units ?? "metric")})`)) });
      case "secret":
        return this.call(`/interactions/${id}/callback`, { type: "reply", ephemeral: true, ...(await text("Only for you: 42")) });
      case "slow":
        await this.call(`/interactions/${id}/callback`, { type: "defer" });
        await new Promise((r) => setTimeout(r, 1500));
        return this.call(`/interactions/${id}/messages`, await text("Finally done"));
      default:
        return this.call(`/interactions/${id}/callback`, { type: "error", message: "Unknown command" });
    }
  }
}

async function openRoom(page: Page, roomId: string) {
  await page.goto(`/rooms/${roomId}`);
  await expect(page.getByTestId("channel-name")).toHaveText("allgemein");
}

/** Types `/wea`, picks the application's command, fills the city and picks `units` from the pick list. */
async function weatherViaPalette(page: Page, app: App, city: string, unitsLabel: string, unitsValue: string) {
  const box = page.getByLabel("Nachricht", { exact: true });
  await box.fill("/wea");
  const option = page.locator(`[data-testid="command-option"][data-source="app"][data-name="weather"]`);
  await expect(option).toBeVisible();
  await expect(option.getByTestId("bot-badge")).toBeVisible();
  await option.click();
  await expect(box).toHaveValue("/weather ");
  await expect(page.getByTestId("command-hint-app")).toContainText(app.name);
  await box.pressSequentially(`${city} `);
  const choice = page.getByTestId("command-suggestion").filter({ hasText: unitsLabel });
  await expect(choice).toBeVisible();
  await choice.click();
  await expect(box).toHaveValue(`/weather ${city} ${unitsValue} `);
  await box.press("Enter");
  await expect(box).toHaveValue("");
}

/** `/secret` (ephemeral) and `/slow` (deferred, then a follow-up). */
async function ephemeralAndDeferred(page: Page) {
  const box = page.getByLabel("Nachricht", { exact: true });
  // Commands without arguments run when picked (Enter, or a click on the option).
  await box.fill("/secret");
  await expect(page.locator(`[data-testid="command-option"][data-name="secret"]`)).toBeVisible();
  await box.press("Enter");
  const ephemeral = page.getByTestId("interaction-ephemeral");
  await expect(ephemeral).toContainText("Only for you: 42");
  await expect(ephemeral).toContainText("Nur du siehst das");
  await expect(page.getByTestId("message").filter({ hasText: "Only for you" })).toHaveCount(0);

  // `/slow` also matches the built-in `/slowmode`: the application's option is picked explicitly.
  await box.fill("/slow");
  const slow = page.locator(`[data-testid="command-option"][data-source="app"][data-name="slow"]`);
  await expect(slow).toBeVisible();
  await slow.click();
  await expect(box).toHaveValue("/slow");
  await box.press("Enter");
  await expect(page.getByTestId("interaction-thinking")).toBeVisible();
  const done = page.getByTestId("message").filter({ hasText: "Finally done" });
  await expect(done).toBeVisible({ timeout: 10_000 });
  await expect(done.getByTestId("message-interaction")).toContainText("/slow");
  await expect(page.getByTestId("interaction-thinking")).toHaveCount(0);
  // Ephemeral replies are dropped on reload.
  await page.reload();
  await expect(page.getByTestId("channel-name")).toHaveText("allgemein");
  await expect(page.getByTestId("interaction-ephemeral")).toHaveCount(0);
}

test.describe("Application commands (APPLICATIONS.md §5, phase 5 step 3)", () => {
  test("palette, pick list, reply, ephemeral reply and thinking in an unencrypted channel; room settings", async ({ page, request }) => {
    test.setTimeout(90_000);
    const owner = await registerViaApi(request, "cmdown");
    const carol = await registerViaApi(request, "cmdroom");
    const app = await createApp(request, owner);
    const room = await createRoomViaApi(request, carol.token, "Befehlsraum");
    await install(request, carol.token, room.id, app);
    const bot = new TestBot(
      app,
      async (_c, content) => ({ content }),
      async (inv) => inv.args ?? {},
    );
    await bot.connect();
    try {
      await loginAs(page, carol);
      await openRoom(page, room.id);
      const box = page.getByLabel("Nachricht", { exact: true });
      await box.fill("/");
      const apps = page.locator(`[data-testid="command-option"][data-source="app"]`);
      await expect(apps).toHaveCount(3);

      await weatherViaPalette(page, app, "Berlin", "Imperial", "imperial");
      const reply = page.getByTestId("message").filter({ hasText: "Berlin: sunny (imperial)" });
      await expect(reply).toBeVisible();
      await expect(reply.getByTestId("bot-badge")).toBeVisible();
      await expect(reply.getByTestId("message-interaction")).toContainText("/weather");
      expect(bot.seen[0]!.args).toEqual({ city: "Berlin", units: "imperial" });

      await ephemeralAndDeferred(page);
      expect(bot.errors).toEqual([]);

      // Room settings: `secret` is switched off for the room, the palette follows.
      await page.goto(`/rooms/${room.id}/settings/applications`);
      const row = page.locator(`[data-testid="room-application-row"][data-ref="${app.ref}"]`);
      await expect(row.getByTestId("room-application-commands")).toContainText("3");
      await row.getByTestId("room-application-commands").click();
      const secret = row.locator(`[data-testid="room-command-row"][data-name="secret"]`);
      await secret.getByTestId("room-command-enabled").uncheck();
      await expect(row.getByTestId("room-application-commands")).toContainText("2");
      await openRoom(page, room.id);
      await box.fill("/");
      await expect(apps).toHaveCount(2);
      await expect(page.locator(`[data-testid="command-option"][data-name="secret"]`)).toHaveCount(0);
    } finally {
      bot.close();
    }
  });

  test("encrypted channel: the arguments and the answers are ciphertext between the browser and the bot", async ({ page, request }) => {
    test.setTimeout(120_000);
    await ensureCrypto();
    const owner = await registerViaApi(request, "cmdown");
    const app = await createApp(request, owner);
    // A user with keys (wizard) in an encrypted room with the bot installed.
    const carol = await registerViaUi(page, { prefix: "cmdenc" });
    const token = await tokenOf(page);
    const room = await createRoomViaApi(request, token, "Geheimer Befehlsraum", "invite", { encrypted: true });
    const channel = room.channels.find((c: { kind: string }) => c.kind === "text");
    await install(request, token, room.id, app);
    // New rooms keep bots out of encrypted channels unless the channel allows them (design note 4.7).
    const allow = await request.patch(`${NODE}/api/v1/rooms/${room.id}/channels/${channel.id}`, { headers: auth(token), data: { bots_allowed: true } });
    expect(allow.status(), await allow.text()).toBe(200);
    // The bot is an E2EE participant: identity, attested device of its token.
    const call = async (method: "GET" | "POST" | "PUT", path: string, data?: unknown) => {
      const resp = await request.fetch(`${NODE}/api/v1${path}`, { method, headers: auth(app.secret), data });
      expect(resp.ok(), `${method} ${path}: ${await resp.text()}`).toBeTruthy();
      return resp.status() === 204 ? null : resp.json();
    };
    const master = MasterSecret.generate();
    await call("PUT", "/users/me/identity", { identity_public_key: b64url(master.identityPublicKey()) });
    const client = Client.create(app.botAddress, app.deviceId);
    await call("PUT", `/users/me/devices/${app.deviceId}/key`, { device_public_key: b64url(client.devicePublicKey), identity_signature: b64url(master.attestDevice(app.botAddress, app.deviceId, client.devicePublicKey)) });

    // The browser creates the channel's group when it opens the channel.
    await openRoom(page, room.id);
    await expect(page.getByTestId("encrypted-marker")).toBeVisible();
    await expect(page.getByLabel("Nachricht", { exact: true })).toBeEnabled({ timeout: 20_000 });
    // The bot joins by external commit (it may view the channel).
    const q = `${DOMAIN}/${channel.id}`;
    const info = await call("GET", `/conversations/${channel.id}/mls/group-info`);
    const out = client.joinByExternalCommit(q, unb64url(info.group_info));
    await call("POST", `/conversations/${channel.id}/mls/commits`, { epoch: out.epoch, commit: b64url(out.commit), group_info: b64url(out.groupInfo), welcome: null });
    client.mergePendingCommit(q);
    const catchUp = async () => {
      const log = await call("GET", `/conversations/${channel.id}/mls/messages?since_epoch=${client.currentEpoch(q)}`);
      for (const item of log.items as Array<{ commit: string }>) client.processHandshake(q, unb64url(item.commit));
    };
    const verifier = new CommandArgsVerifier();
    const bot = new TestBot(
      app,
      async (_c, content) => {
        await catchUp();
        return { content: client.encryptContent(q, JSON.stringify(content)), epoch: client.currentEpoch(q) };
      },
      async (inv) => {
        expect(inv.encrypted).toBe(true);
        expect(inv.args).toBeNull();
        await catchUp();
        const plain = JSON.parse(client.decryptContent(q, inv.user, inv.device_id, inv.args_ciphertext!, undefined));
        const checked = verifier.check(plain, `${app.ref}/${inv.command.id}`);
        if (!checked.ok) throw new Error(`arguments refused: ${checked.reason}`);
        return checked.args;
      },
    );
    await bot.connect();
    try {
      await weatherViaPalette(page, app, "Rome", "Metric", "metric");
      const reply = page.getByTestId("message").filter({ hasText: "Rome: sunny (metric)" });
      await expect(reply).toBeVisible({ timeout: 15_000 });
      await expect(reply.getByTestId("message-interaction")).toContainText("/weather");
      await ephemeralAndDeferred(page);
      expect(bot.errors).toEqual([]);
      expect(bot.seen.every((s) => s.args === null && typeof s.args_ciphertext === "string")).toBe(true);
      // The node only holds ciphertext.
      const stored = await (await request.get(`${NODE}/api/v1/conversations/${channel.id}/messages?limit=20`, { headers: auth(token) })).json();
      expect(JSON.stringify(stored)).not.toContain("sunny");
      expect(JSON.stringify(stored)).not.toContain("Finally done");
      expect(carol.address).toContain("@");
    } finally {
      bot.close();
    }
  });
});
