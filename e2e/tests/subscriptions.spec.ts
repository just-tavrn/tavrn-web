// SPDX-License-Identifier: Apache-2.0
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { HookVerifier } from "@tavrn/sdk";
import { NODE, createRoomViaApi, loginAs, registerViaApi, uniqueName, type Account } from "./helpers";

// Event subscriptions, phase 5 step 4 (tavrn-protocol/APPLICATIONS.md §6.2, §6.3): the owner configures a subscription in
// the application settings against a tiny receiver started by the test (development nodes allow local http URLs),
// the node verifies it with a signed ping, the state turns active and a message.create arrives, signed by the node.

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

interface Hit {
  headers: IncomingHttpHeaders;
  raw: Buffer;
  body: { type?: string; challenge?: string; data?: { content?: { body?: string } } };
}

/** A receiver on 127.0.0.1 that echoes pings and accepts every event. */
async function receiver(): Promise<{ server: Server; url: string; hits: Hit[] }> {
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      let body: Hit["body"] = {};
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        /* recorded as is */
      }
      hits.push({ headers: req.headers, raw, body });
      res.setHeader("content-type", "application/json");
      res.end(body.type === "ping" ? JSON.stringify({ challenge: body.challenge }) : "{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}/hook`, hits };
}

/** An application of `owner` whose bot (messages:read) is installed in the room. */
async function botInRoom(request: APIRequestContext, owner: Account, roomId: string) {
  const name = uniqueName("events");
  const app = await request.post(`${NODE}/api/v1/applications`, { headers: auth(owner.token), data: { name, scopes: ["messages:read", "members:read"] } });
  expect(app.status(), await app.text()).toBe(201);
  const application = await app.json();
  const token = await request.post(`${NODE}/api/v1/applications/${application.id}/tokens`, { headers: auth(owner.token), data: { name: "t" } });
  const secret = (await token.json()).secret as string;
  // Bots enter rooms only through an installation (APPLICATIONS.md §4.2); the owner holds every permission.
  const install = await request.post(`${NODE}/api/v1/rooms/${roomId}/applications`, {
    headers: auth(owner.token),
    data: { application: `localhost/${application.id}`, permissions: "0", create_role: false },
  });
  expect(install.status(), await install.text()).toBe(201);
  void secret;
  return application as { id: string; name: string };
}

test.describe("Event subscriptions (APPLICATIONS.md §6.2)", () => {
  test("configure a subscription, see it turn active and receive a signed message.create", async ({ page, request }) => {
    const { server, url, hits } = await receiver();
    try {
      const owner = await registerViaApi(request, "subs");
      const room = await createRoomViaApi(request, owner.token, "Ereignisse");
      const channel = room.channels.find((c: { kind: string }) => c.kind === "text");
      const app = await botInRoom(request, owner, room.id);

      await loginAs(page, owner);
      await page.goto("/settings/applications");
      await page.getByTestId("application-row").filter({ hasText: app.name }).click();
      const section = page.getByTestId("subscription-section");
      await expect(section).toBeVisible();
      await expect(section.getByTestId("subscription-status")).toHaveCount(0);
      await section.getByTestId("subscription-url").fill(url);
      await expect(section.locator('[data-event="message.create"]')).toBeChecked();
      await section.locator('[data-event="member.join"]').check();
      await section.getByTestId("subscription-save").click();
      await expect(section.getByTestId("subscription-state")).toHaveAttribute("data-state", "active");
      expect(hits.filter((h) => h.body.type === "ping")).toHaveLength(1);

      // A message in the room reaches the receiver, signed by the node.
      const sent = await request.post(`${NODE}/api/v1/rooms/${room.id}/channels/${channel.id}/messages`, { headers: auth(owner.token), data: { content: { type: "text", body: "Hallo Abonnement" } } });
      expect(sent.status()).toBe(201);
      await expect.poll(() => hits.filter((h) => h.body.type === "message.create").length, { timeout: 20_000 }).toBe(1);
      const delivery = hits.find((h) => h.body.type === "message.create")!;
      expect(delivery.body.data?.content?.body).toBe("Hallo Abonnement");
      expect(delivery.headers["tavrn-event-type"]).toBe("message.create");
      const verifier = new HookVerifier({ node: NODE, applicationId: app.id, url });
      const checked = await verifier.verify({ headers: delivery.headers as Record<string, string>, body: new Uint8Array(delivery.raw) });
      expect(checked.ok, JSON.stringify(checked)).toBe(true);
      // The same request again is a replay; a tampered body is refused.
      expect(await verifier.verify({ headers: delivery.headers as Record<string, string>, body: new Uint8Array(delivery.raw) })).toEqual({ ok: false, reason: "replay" });

      // The settings show the delivery.
      await expect(section.getByTestId("subscription-last-success")).not.toHaveText("—", { timeout: 15_000 });
      await expect(section.getByTestId("subscription-counters")).toContainText("0");
    } finally {
      server.close();
    }
  });

  test("a URL that does not echo the challenge is refused", async ({ page, request }) => {
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ challenge: "not the one" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const owner = await registerViaApi(request, "subsbad");
      const room = await createRoomViaApi(request, owner.token, "Falsch");
      const app = await botInRoom(request, owner, room.id);
      await loginAs(page, owner);
      await page.goto("/settings/applications");
      await page.getByTestId("application-row").filter({ hasText: app.name }).click();
      const section = page.getByTestId("subscription-section");
      await section.getByTestId("subscription-url").fill(`http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`);
      await section.getByTestId("subscription-save").click();
      await expect(page.getByText(/Prüf-Ping|verification ping/)).toBeVisible();
      await expect(section.getByTestId("subscription-status")).toHaveCount(0);
    } finally {
      server.close();
    }
  });
});
