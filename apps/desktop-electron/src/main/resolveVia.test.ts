// SPDX-License-Identifier: Apache-2.0
// The SRV step's own connection (HttpFetcher.getVia) caps the body like the net.fetch path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createTlsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpFetcher, MAX_DOCUMENT } from "./resolve.ts";

test("getVia refuses an oversized body and a redirect", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tavrn-review-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const o = (...a: string[]) =>
    execFileSync("openssl", a, { cwd: dir, stdio: "pipe" });
  o(
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-keyout",
    "ca.key",
    "-out",
    "ca.pem",
    "-days",
    "2",
    "-subj",
    "/CN=ca",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign",
  );
  o(
    "req",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-keyout",
    "l.key",
    "-out",
    "l.csr",
    "-subj",
    "/CN=home.test",
    "-addext",
    "subjectAltName=DNS:home.test",
  );
  o(
    "x509",
    "-req",
    "-in",
    "l.csr",
    "-CA",
    "ca.pem",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-out",
    "l.pem",
    "-days",
    "2",
    "-copy_extensions",
    "copy",
  );
  const s = createTlsServer(
    {
      key: readFileSync(join(dir, "l.key")),
      cert: readFileSync(join(dir, "l.pem")),
    },
    (req, res) => {
      if (req.url?.includes("redirect")) {
        res.writeHead(302, { Location: "https://evil.test/" });
        return res.end();
      }
      res.end(Buffer.alloc(MAX_DOCUMENT + 10, 0x20));
    },
  );
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  t.after(() => s.close());
  const port = (s.address() as AddressInfo).port;
  const f = new HttpFetcher(
    async () => Promise.reject(new TypeError("x")),
    "t",
    {
      ca: [readFileSync(join(dir, "ca.pem"), "utf8")],
      resolveTarget: () => "127.0.0.1",
    },
  );
  await assert.rejects(
    f.getVia("https://home.test/.well-known/tavrn", {
      host: "target.test",
      port,
    }),
    { kind: "refused" },
  );
  await assert.rejects(
    f.getVia("https://home.test/redirect", { host: "target.test", port }),
    { kind: "refused" },
  );
});
