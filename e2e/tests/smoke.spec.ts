// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

test.describe("Scaffold", () => {
  test("The sign-in page loads and shows the node from /api/v1/node", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByTestId("node-name")).toHaveText(/tavrn \(localhost\)/);
    await expect(page.getByRole("tab", { name: "Anmelden" })).toBeVisible();
    const logo = page.getByRole("img", { name: "tavrn", exact: true });
    await expect(logo).toBeVisible();
    expect(await logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  });

  test("The discovery document is reachable via the client origin", async ({ request }) => {
    const resp = await request.get("/.well-known/tavrn");
    expect(resp.ok()).toBeTruthy();
    const json = await resp.json();
    expect(json.tavrn).toBe(1);
    expect(json.domain).toBe("localhost");
    expect(json.keys).toHaveLength(1);
  });

  test("an unknown API path returns Problem Details", async ({ request }) => {
    const resp = await request.get("/api/v1/nicht-da");
    expect(resp.status()).toBe(404);
    expect(resp.headers()["content-type"]).toContain("application/problem+json");
    expect((await resp.json()).code).toBe("route.not_found");
  });
});
