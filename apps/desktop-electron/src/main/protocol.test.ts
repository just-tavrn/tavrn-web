// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_ORIGIN, contentType, handleAppRequest, isAppUrl, resolveAppRequest } from "./protocol.ts";

function bundle(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), "tavrn-electron-dist-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "assets", "excalidraw", "fonts"), { recursive: true });
  mkdirSync(join(root, "mediapipe"), { recursive: true });
  writeFileSync(join(root, "index.html"), "<!doctype html><html></html>");
  writeFileSync(join(root, "assets", "index-B1x_9aZc.js"), "export {}");
  writeFileSync(join(root, "assets", "tavrn_crypto_bg-Dq3k2LmN.wasm"), "\0asm");
  writeFileSync(join(root, "assets", "excalidraw", "fonts", "Virgil.woff2"), "w");
  writeFileSync(join(root, "mediapipe", "vision_wasm_internal.wasm"), "\0asm");
  writeFileSync(join(root, "icon-512.png"), "png");
  return root;
}

const html = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

test("the app origin is app://tavrn", () => {
  assert.equal(APP_ORIGIN, "app://tavrn");
  assert.ok(isAppUrl("app://tavrn/") && isAppUrl("app://tavrn/rooms/1?x#y"));
  for (const bad of ["app://evil/", "app://tavrn.evil/", "https://tavrn/", "file:///index.html", "app:tavrn", "not a url"]) assert.ok(!isAppUrl(bad), bad);
});

test("serves files of the bundle with their types", (t) => {
  const root = bundle(t);
  const js = resolveAppRequest("app://tavrn/assets/index-B1x_9aZc.js", "*/*", root);
  assert.equal(js.status, 200);
  assert.equal(js.status === 200 && js.file, join(root, "assets", "index-B1x_9aZc.js"));
  assert.equal(js.headers["Content-Type"], "text/javascript; charset=utf-8");
  assert.equal(resolveAppRequest("app://tavrn/assets/tavrn_crypto_bg-Dq3k2LmN.wasm", "*/*", root).headers["Content-Type"], "application/wasm");
  assert.equal(resolveAppRequest("app://tavrn/icon-512.png", "*/*", root).headers["Content-Type"], "image/png");
  assert.equal(resolveAppRequest("app://tavrn/assets/excalidraw/fonts/Virgil.woff2", "*/*", root).headers["Content-Type"], "font/woff2");
});

test("hashed assets are immutable, everything else is revalidated", (t) => {
  const root = bundle(t);
  assert.equal(resolveAppRequest("app://tavrn/assets/index-B1x_9aZc.js", "*/*", root).headers["Cache-Control"], "public, max-age=31536000, immutable");
  for (const path of ["/", "/index.html", "/assets/excalidraw/fonts/Virgil.woff2", "/mediapipe/vision_wasm_internal.wasm", "/icon-512.png"]) {
    assert.equal(resolveAppRequest(`app://tavrn${path}`, html, root).headers["Cache-Control"], "no-cache", path);
  }
});

test("pages of the client get index.html with the policy; missing files are 404", (t) => {
  const root = bundle(t);
  for (const path of ["/", "/login", "/rooms/1/channels/2", "/u/alice@tavrn.example", "/n/home.example/rooms/1", "/node?x=1#y"]) {
    const r = resolveAppRequest(`app://tavrn${path}`, html, root);
    assert.equal(r.status === 200 && r.file, join(root, "index.html"), path);
    assert.equal(r.headers["Content-Type"], "text/html; charset=utf-8");
    assert.match(r.headers["Content-Security-Policy"] ?? "", /script-src 'self' 'wasm-unsafe-eval'/);
  }
  // A script, a fetch or an image that is not in the bundle: no HTML in its place.
  assert.equal(resolveAppRequest("app://tavrn/assets/missing-AAAAAAAA.js", "*/*", root).status, 404);
  assert.equal(resolveAppRequest("app://tavrn/api/v1/me", "application/json", root).status, 404);
  // Directories are not files.
  assert.equal(resolveAppRequest("app://tavrn/assets", "*/*", root).status, 404);
  for (const r of [resolveAppRequest("app://tavrn/assets/index-B1x_9aZc.js", "*/*", root)]) {
    assert.equal(r.headers["Content-Security-Policy"], undefined, "the policy belongs to documents");
    assert.equal(r.headers["X-Content-Type-Options"], "nosniff");
  }
});

test("never leaves the bundle", (t) => {
  const root = bundle(t);
  writeFileSync(join(root, "..", "secret.txt"), "s");
  t.after(() => rmSync(join(root, "..", "secret.txt"), { force: true }));
  for (const path of ["/../secret.txt", "/%2e%2e/secret.txt", "/assets/%2e%2e%2f%2e%2e%2fsecret.txt", "/..%5csecret.txt", "/%00", "/%E0%A4%A"]) {
    const r = resolveAppRequest(`app://tavrn${path}`, "*/*", root);
    assert.ok(r.status === 404 || r.status === 400, path);
  }
  assert.equal(resolveAppRequest("app://evil/index.html", html, root).status, 404, "another host of the scheme");
});

test("answers GET only, and streams the file", async (t) => {
  const root = bundle(t);
  const ok = await handleAppRequest(new Request("app://tavrn/assets/index-B1x_9aZc.js"), root);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "export {}");
  assert.equal(ok.headers.get("content-length"), "9");
  const page = await handleAppRequest(new Request("app://tavrn/login", { headers: { accept: html } }), root);
  assert.equal(await page.text(), "<!doctype html><html></html>");
  assert.equal((await handleAppRequest(new Request("app://tavrn/", { method: "POST", body: "x" }), root)).status, 405);
  assert.equal((await handleAppRequest(new Request("app://tavrn/nope.js"), root)).status, 404);
});

test("content types of the bundle's files", () => {
  assert.equal(contentType("a.css"), "text/css; charset=utf-8");
  assert.equal(contentType("a.mjs"), "text/javascript; charset=utf-8");
  assert.equal(contentType("a.json"), "application/json");
  assert.equal(contentType("a.svg"), "image/svg+xml");
  assert.equal(contentType("manifest.webmanifest"), "application/manifest+json");
  assert.equal(contentType("model.tflite"), "application/octet-stream");
  assert.equal(contentType("README"), "application/octet-stream");
});
