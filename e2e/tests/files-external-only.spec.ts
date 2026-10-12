// SPDX-License-Identifier: Apache-2.0
/**
 * Files channels on external stores only (tavrn-protocol FILES.md §5): the node of `filesPolicy` in the Playwright
 * config runs with TAVRN_FILES_INTERNAL=off. A new files channel shows "choose a store first" instead of the upload
 * button; its storage settings refuse the node's own storage; once a WebDAV store (a small one in this spec) is set,
 * uploads go there.
 */
import { createServer, type Server } from "node:http";
import { expect, test } from "@playwright/test";
import { createRoomViaApi, loginAs, registerViaApi } from "./helpers";

const plus = (port: string, n: number) => String(Number(port) + n);
const FILES_NODE = `http://127.0.0.1:${process.env.E2E_NODE_PORT_FILES ?? plus(process.env.E2E_NODE_PORT ?? "8080", 3)}`;
const FILES_WEB = `http://localhost:${process.env.E2E_WEB_PORT_FILES ?? plus(process.env.E2E_WEB_PORT ?? "5173", 3)}`;

/** A WebDAV store in memory, enough for the node's test, MKCOL, PUT, GET and DELETE (FILES.md §5). */
async function webdav(): Promise<{ url: string; objects: Map<string, Buffer>; server: Server }> {
  const objects = new Map<string, Buffer>();
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const path = req.url ?? "/";
      const status = (code: number, body?: Buffer | string) => {
        res.statusCode = code;
        res.end(body);
      };
      switch (req.method) {
        case "PROPFIND":
          return status(207, '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"/>');
        case "MKCOL":
          return status(201);
        case "PUT":
          objects.set(path, Buffer.concat(chunks));
          return status(201);
        case "GET":
          return objects.has(path) ? status(200, objects.get(path)) : status(404);
        case "DELETE":
          return status(objects.delete(path) ? 204 : 404);
        default:
          return status(405);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}/dav/`, objects, server };
}

test("a files channel on a node without internal storage asks for a store before the first upload", async ({ page, request }) => {
  const store = await webdav();
  try {
    const owner = await registerViaApi(request, "extonly", FILES_NODE);
    const room = await createRoomViaApi(request, owner.token, "Ablage", "invite", { base: FILES_NODE });
    const auth = { Authorization: `Bearer ${owner.token}` };
    const node = await (await request.get(`${FILES_NODE}/api/v1/node`)).json();
    expect(node.files_internal).toBe(false);
    const created = await request.post(`${FILES_NODE}/api/v1/rooms/${room.id}/channels`, { headers: auth, data: { kind: "files", name: "ablage", encrypted: false } });
    expect(created.status()).toBe(201);
    const ch = await created.json();

    await loginAs(page, owner);
    await page.goto(`${FILES_WEB}/rooms/${room.id}/channels/${ch.id}`);
    await expect(page.getByTestId("files-view")).toBeVisible();
    const choose = page.getByRole("link", { name: "Zuerst einen Speicher wählen" });
    await expect(choose).toBeVisible();
    await expect(page.getByTestId("files-upload-button")).toHaveCount(0);
    await expect(page.getByTestId("files-empty")).toContainText("Dieser Knoten speichert selbst keine Dateien von Dateichannels");

    // The channel's storage settings: the node's own storage cannot be chosen; a WebDAV store can.
    await choose.click();
    const storage = page.getByTestId("files-storage");
    await expect(storage).toBeVisible();
    await expect(storage.locator('option[value="internal"]')).toBeDisabled();
    await expect(storage.getByTestId("files-storage-kind")).toHaveValue("webdav");
    await storage.getByTestId("files-storage-url").fill(store.url);
    await storage.getByTestId("files-storage-username").fill("team");
    await storage.getByTestId("files-storage-password").fill("store-password");
    await storage.getByTestId("files-storage-save").click();
    await expect(page.getByText("Speicher gespeichert")).toBeVisible();

    // Back in the channel the upload goes to the store.
    await page.goto(`${FILES_WEB}/rooms/${room.id}/channels/${ch.id}`);
    await expect(page.getByTestId("files-upload-button")).toBeVisible();
    await expect(page.getByTestId("files-choose-store")).toHaveCount(0);
    await expect(page.getByTestId("files-banner-external")).toContainText("WebDAV");
    await page.getByTestId("files-upload-input").setInputFiles({ name: "plan.txt", mimeType: "text/plain", buffer: Buffer.from("auf dem eigenen Speicher") });
    await expect(page.getByTestId("file-row")).toHaveAttribute("data-name", "plan.txt");
    expect([...store.objects.values()].map((b) => b.toString())).toContain("auf dem eigenen Speicher");
  } finally {
    store.server.close();
  }
});
