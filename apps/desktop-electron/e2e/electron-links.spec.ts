// SPDX-License-Identifier: Apache-2.0
/**
 * Links into the app (docs/DESKTOP.md "Links into the app"): a `tavrn://` link as the argument of the start and of a
 * second start (as the desktop's `x-scheme-handler/tavrn` entry starts the app) reaches the client, which shows the
 * target before anything happens; an invalid link is dropped by the shell. Development build or package alike (the
 * main process is not needed).
 */
import { expect, test } from "@playwright/test";
import { nodeUrl, webOrigin } from "./harness.ts";
import { startApp, type ElectronApp } from "./launch.ts";

const chosen = { node: nodeUrl, web: webOrigin, domain: "localhost" };
let run: ElectronApp | null = null;

test.afterEach(async () => {
  await run?.close();
  run = null;
});

test("a start and a second start with a tavrn:// link ask before they open it", async ({}, testInfo) => {
  run = await startApp({ settings: chosen, args: ["tavrn://invite/chat.example/Code_1234"] });
  const { page } = run;
  // The link of the start waited in the shell until the client listened.
  const prompt = page.getByTestId("deep-link-prompt");
  await expect(prompt).toBeVisible({ timeout: 30_000 });
  await expect(prompt).toHaveAttribute("data-kind", "invite");
  await expect(page.getByTestId("deep-link-target")).toContainText("chat.example");
  await expect(page.getByTestId("deep-link-url")).toHaveText("tavrn://invite/chat.example/Code_1234");
  await expect(page).toHaveURL(/^app:\/\/tavrn\/login/);
  await page.screenshot({ path: testInfo.outputPath("start-link.png") });
  await page.getByTestId("deep-link-cancel").click();
  await expect(prompt).toBeHidden();

  // A second start hands its link to the running app and exits; an invalid link never reaches the client.
  expect(await run.secondStart(["tavrn://invite/localhost/Code_1234"])).toBe(0);
  expect(await run.secondStart(["tavrn://room/chat.example/01J9ZQ/01JA00"])).toBe(0);
  await expect(prompt).toBeVisible({ timeout: 30_000 });
  await expect(prompt).toHaveAttribute("data-kind", "room");
  await expect(page.getByTestId("deep-link-url")).toHaveText("tavrn://room/chat.example/01J9ZQ/01JA00");
  await page.screenshot({ path: testInfo.outputPath("second-start-link.png") });
  // Open goes there (signed out: the sign-in comes first, with the room as the next page).
  await page.getByTestId("deep-link-open").click();
  await expect(page).toHaveURL(/\/login\?next=%2Fn%2Fchat\.example%2Frooms%2F01J9ZQ%2Fchannels%2F01JA00/, { timeout: 30_000 });
  await expect(prompt).toBeHidden();
});
