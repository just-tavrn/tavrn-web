// SPDX-License-Identifier: Apache-2.0
import { expect, test, type APIRequestContext } from "@playwright/test";
import { NODE, createRoomViaApi, inviteCode, loginAs, registerViaApi, registerViaUi, tokenOf } from "./helpers";

/** Slash commands in the composer (design note 4.11, PROTOCOL.md §4.1). */

async function join(request: APIRequestContext, token: string, code: string) {
  const resp = await request.post(`${NODE}/api/v1/invites/${code}/join`, { headers: { Authorization: `Bearer ${token}` }, data: {} });
  expect(resp.ok()).toBeTruthy();
}

test.describe("Slash commands", () => {
  test("a moderator times a member out through the palette; /me renders as an action", async ({ page, request }) => {
    const alice = await registerViaApi(request, "alice");
    const bob = await registerViaApi(request, "bob");
    const room = await createRoomViaApi(request, alice.token, "Befehle");
    await join(request, bob.token, await inviteCode(request, alice.token, room.id));
    await loginAs(page, alice);
    await page.goto(`/rooms/${room.id}`);
    await expect(page.getByTestId("channel-name")).toHaveText("allgemein");

    const box = page.getByLabel("Nachricht", { exact: true });
    await box.fill("/ti");
    const palette = page.getByTestId("command-palette");
    await expect(palette).toBeVisible();
    await expect(palette.getByTestId("command-option").first()).toHaveAttribute("data-name", "timeout");
    await box.press("Enter");
    await expect(box).toHaveValue("/timeout ");
    await expect(page.getByTestId("command-hint")).toContainText("/timeout");
    await box.pressSequentially(`@${bob.username.slice(0, 4)}`);
    // The member suggestion completes the address.
    await expect(page.getByTestId("command-suggestion").first()).toContainText(bob.username);
    await box.press("Tab");
    await expect(box).toHaveValue(`/timeout @${bob.username} `);
    await box.pressSequentially("10m zu laut");
    await box.press("Enter");
    await expect(box).toHaveValue("");
    await expect(page.getByText(`${bob.username}@localhost ist für 10 Minuten im Timeout`)).toBeVisible();
    const members = await request.get(`${NODE}/api/v1/rooms/${room.id}/members`, { headers: { Authorization: `Bearer ${alice.token}` } });
    const timedOut = (await members.json()).find((m: { user: { id: string } }) => m.user.id === bob.userId);
    expect(timedOut.timeout_until).toBeTruthy();

    // /me is sent as an action and shown in italics; nothing was sent for the command itself.
    await box.fill("/me winkt in die Runde");
    await box.press("Enter");
    const action = page.getByTestId("action-message").filter({ hasText: "winkt in die Runde" });
    await expect(action).toBeVisible();
    await expect(action).toHaveClass(/italic/);
    await expect(page.getByTestId("message").filter({ hasText: "/timeout" })).toHaveCount(0);
  });

  test("members without moderation rights do not see moderation commands", async ({ page, request }) => {
    const alice = await registerViaApi(request, "alice");
    const bob = await registerViaApi(request, "bob");
    const room = await createRoomViaApi(request, alice.token, "Befehle");
    await join(request, bob.token, await inviteCode(request, alice.token, room.id));
    await loginAs(page, bob);
    await page.goto(`/rooms/${room.id}`);
    await expect(page.getByTestId("channel-name")).toHaveText("allgemein");
    const box = page.getByLabel("Nachricht", { exact: true });
    await box.fill("/");
    const names = await page.getByTestId("command-option").evaluateAll((els) => els.map((e) => e.getAttribute("data-name")));
    expect(names).toEqual(expect.arrayContaining(["help", "me", "shrug", "nick"]));
    for (const forbidden of ["kick", "ban", "timeout", "purge", "slowmode", "topic", "mute", "move"]) expect(names).not.toContain(forbidden);
    // Typing a moderation command anyway sends it as plain text.
    await box.fill("/kick @alice");
    await box.press("Enter");
    await expect(page.getByTestId("message").filter({ hasText: "/kick @alice" })).toBeVisible();
    // /help lists what is available.
    await box.fill("/help");
    await box.press("Enter");
    await expect(page.getByTestId("command-help")).toContainText("/me");
    await expect(page.getByTestId("command-help")).not.toContainText("/kick");
  });
  test("/me and /shrug in an encrypted channel go through the composer's encrypted send path", async ({ page, request }) => {
    test.setTimeout(90_000);
    // A device with keys (wizard), then an encrypted room opened fresh: the command runner is built
    // while the device is still joining the group and must use the manager once it is ready.
    await registerViaUi(page, { prefix: "geheim" });
    const token = await tokenOf(page);
    const room = await createRoomViaApi(request, token, "Geheime Befehle", "invite", { encrypted: true });
    const channel = room.channels.find((c: { kind: string }) => c.kind === "text");
    await page.goto(`/rooms/${room.id}`);
    await expect(page.getByTestId("channel-name")).toHaveText("allgemein");
    await expect(page.getByTestId("encrypted-marker")).toBeVisible();
    const box = page.getByLabel("Nachricht", { exact: true });
    await expect(box).toBeEnabled({ timeout: 15_000 });

    await box.fill("/me winkt verschlüsselt");
    await box.press("Enter");
    await expect(box).toHaveValue("");
    const action = page.getByTestId("action-message").filter({ hasText: "winkt verschlüsselt" });
    await expect(action).toBeVisible();
    await box.fill("/shrug egal");
    await box.press("Enter");
    await expect(box).toHaveValue("");
    await expect(page.getByTestId("message").filter({ hasText: "egal ¯\\_(ツ)_/¯" })).toBeVisible();
    await expect(page.getByText(/konnte nicht gesendet werden/)).toHaveCount(0);

    // The node only holds ciphertext.
    const resp = await request.get(`${NODE}/api/v1/conversations/${channel.id}/messages?limit=10`, { headers: { Authorization: `Bearer ${token}` } });
    expect(resp.ok()).toBeTruthy();
    const stored = (await resp.json()) as Array<{ encrypted: boolean; content: unknown }>;
    const sent = stored.filter((m) => m.encrypted);
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(stored)).not.toContain("winkt verschlüsselt");
    expect(JSON.stringify(stored)).not.toContain("egal");
  });
});
