// SPDX-License-Identifier: Apache-2.0
// The same cases as apps/desktop/src-tauri/src/node_url.rs and resolve.rs (valid_domain): both shells accept the same nodes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NodeUrlError, validDomain, validateNodeUrl } from "./node_url.ts";

const ok = (input: string) => validateNodeUrl(input);
const err = (input: string): string => {
  try {
    validateNodeUrl(input);
  } catch (e) {
    assert.ok(e instanceof NodeUrlError, `${input}: ${String(e)}`);
    return e.code;
  }
  assert.fail(`${input} was accepted`);
};

test("accepts https origins and normalizes them", () => {
  assert.equal(ok("https://tavrn.example"), "https://tavrn.example");
  assert.equal(ok("  https://Tavrn.Example/  "), "https://tavrn.example");
  assert.equal(ok("https://chat.tavrn.example:8443/"), "https://chat.tavrn.example:8443");
  assert.equal(ok("https://tavrn.example:443"), "https://tavrn.example");
  assert.equal(ok("https://bücher.example"), "https://xn--bcher-kva.example");
});

test("plain http only for a development node on this computer", () => {
  assert.equal(ok("http://localhost:8080"), "http://localhost:8080");
  assert.equal(ok("http://127.0.0.1:8300/"), "http://127.0.0.1:8300");
  for (const bad of ["http://evil", "http://tavrn.example", "http://192.168.1.2", "http://localhost.evil.example", "http://127.0.0.2"]) {
    assert.equal(err(bad), "node_url.insecure", bad);
  }
});

test("refuses credentials", () => {
  for (const bad of ["https://user:pw@tavrn.example", "https://user@tavrn.example", "https://:pw@tavrn.example"]) {
    assert.equal(err(bad), "node_url.credentials", bad);
  }
});

test("refuses paths, queries and fragments", () => {
  for (const bad of ["https://tavrn.example/app", "https://tavrn.example/?x=1", "https://tavrn.example/?", "https://tavrn.example/#top", "https://tavrn.example//", "https://tavrn.example/#"]) {
    assert.equal(err(bad), "node_url.path", bad);
  }
});

test("refuses other schemes and garbage", () => {
  const long = `https://${"a".repeat(300)}.example`;
  for (const bad of ["", "   ", "tavrn.example", "ftp://tavrn.example", "javascript:alert(1)", "file:///etc/passwd", "tauri://localhost", "app://tavrn", "https://", "https://exa mple.org", long]) {
    assert.equal(err(bad), "node_url.invalid", bad);
  }
  // The limit counts bytes, as the Rust shell does.
  assert.equal(err(`https://${"ü".repeat(150)}.example`), "node_url.invalid");
});

test("node domains: lowercase labels, a dot, no port, no IP literal", () => {
  assert.ok(validDomain("home.example") && validDomain("a-b.c.example"));
  for (const bad of ["localhost", "1.2.3.4", "HOME.example", "", "-a.example", "a-.example", "a..example", "a.example:8080", `${"a".repeat(64)}.example`, `${"a.".repeat(127)}example`]) {
    assert.ok(!validDomain(bad), bad);
  }
});
