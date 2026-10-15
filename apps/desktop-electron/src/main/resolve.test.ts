// SPDX-License-Identifier: Apache-2.0
// The cases of apps/desktop/src-tauri/src/resolve.rs, with a fake fetcher and SRV lookup, plus the real fetcher once
// against a local server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createTlsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FetchError, HttpFetcher, MAX_DOCUMENT, devHost, resolveNode, type FetchLike, type Fetched, type Fetcher, type SrvLookup, type SrvRecord } from "./resolve.ts";

class Fake implements Fetcher, SrvLookup {
  answers = new Map<string, Fetched | FetchError>();
  records = new Map<string, SrvRecord[]>();
  fetched: string[] = [];
  srvAsked: string[] = [];
  answer(url: string, status: number, body: unknown): this {
    this.answers.set(url, { status, body: new TextEncoder().encode(JSON.stringify(body)) });
    return this;
  }
  fail(url: string, kind: "transport" | "refused"): this {
    this.answers.set(url, new FetchError(kind));
    return this;
  }
  srvRecords(name: string, records: Array<[number, number, number, string]>): this {
    this.records.set(name, records.map(([priority, weight, port, target]) => ({ priority, weight, port, target })));
    return this;
  }
  async get(url: string): Promise<Fetched> {
    this.fetched.push(url);
    const r = this.answers.get(url) ?? new FetchError("transport");
    if (r instanceof FetchError) throw r;
    return r;
  }
  /** SRV step: the request names the identity domain, the connection goes to `host:port` (answers keyed by that). */
  async getVia(url: string, connect: { host: string; port: number }): Promise<Fetched> {
    const key = `${url} via ${connect.host}:${connect.port}`;
    this.fetched.push(key);
    const r = this.answers.get(key) ?? new FetchError("transport");
    if (r instanceof FetchError) throw r;
    return r;
  }
  async srv(name: string): Promise<SrvRecord[]> {
    this.srvAsked.push(name);
    const r = this.records.get(name);
    if (!r) throw new Error("no records");
    return r;
  }
}

const doc = (domain: string, host: string): Record<string, unknown> => ({ tavrn: 1, domain, api: `https://${host}/api/v1`, ws: `wss://${host}/api/v1/ws`, web: `https://${host}`, capabilities: [] });
const run = (domain: string, fake: Fake) => resolveNode(domain, fake, fake);
const WK = "https://home.example/.well-known/tavrn";
const fail = (code: string, step: string, domain: string) => ({ code, step, domain });

test("the well-known on the domain, with delegation", async () => {
  const fake = new Fake().answer(WK, 200, doc("home.example", "app.home.example"));
  assert.deepEqual(await run(" Home.Example ", fake), { domain: "home.example", api: "https://app.home.example/api/v1", ws: "wss://app.home.example/api/v1/ws", web: "https://app.home.example", source: "well_known" });
  assert.deepEqual(fake.srvAsked, [], "SRV only when the domain serves no document");
});

test("a web origin on another site is replaced by the API's origin", async () => {
  const other = { ...doc("home.example", "app.home.example"), web: "https://tavrn.org" };
  assert.equal((await run("home.example", new Fake().answer(WK, 200, other))).web, "https://app.home.example");
  // Delegation to another domain: the web client only on the node's own host.
  const hosted = { ...doc("home.example", "hosting.example"), web: "https://www.home.example" };
  assert.equal((await run("home.example", new Fake().answer(WK, 200, hosted))).web, "https://hosting.example");
  const within = { ...doc("home.example", "api.home.example"), web: "https://home.example" };
  assert.equal((await run("home.example", new Fake().answer(WK, 200, within))).web, "https://home.example", "within the identity domain");
});

test("invalid documents are refused at their step", async () => {
  const bad: unknown[] = [];
  for (const [key, value] of [
    ["tavrn", 2],
    ["domain", "other.example"],
    ["api", "http://app.home.example/api/v1"],
    ["api", "https://user:pw@app.home.example/api/v1"],
    ["api", "https://app.home.example/api/v1?x=1"],
    ["api", "https://app.home.example/api/v1?"],
    ["api", "https://app.home.example/api"],
    ["ws", "ws://app.home.example/api/v1/ws"],
    ["web", "https://app.home.example/#x"],
  ] as const) {
    bad.push({ ...doc("home.example", "app.home.example"), [key]: value });
  }
  bad.push("not an object", [1], null);
  for (const d of bad) {
    await assert.rejects(run("home.example", new Fake().answer(WK, 200, d)), fail("resolve.invalid", "well_known", "home.example"), JSON.stringify(d));
  }
  const notJson = new Fake();
  notJson.answers.set(WK, { status: 200, body: new TextEncoder().encode("<html>") });
  await assert.rejects(run("home.example", notJson), fail("resolve.invalid", "well_known", "home.example"));
});

test("after a 404 the SRV records in order", async () => {
  const fake = new Fake()
    .answer(WK, 404, {})
    .srvRecords("_tavrn._tcp.home.example", [
      [20, 0, 443, "late.example"],
      [10, 1, 8443, "light.example"],
      [10, 9, 8443, "heavy.example."],
      [5, 0, 443, "10.0.0.1"],
    ])
    .answer(`${WK} via light.example:8443`, 200, doc("home.example", "light.example"));
  const found = await run("home.example", fake);
  assert.deepEqual([found.source, found.api], ["srv", "https://light.example/api/v1"]);
  // The IP literal is skipped; heavy (priority 10, weight 9) before light (weight 1); late is never reached. Every SRV
  // request is made for the identity domain (its certificate must be valid for it), connected to the target.
  assert.deepEqual(fake.fetched, [WK, `${WK} via heavy.example:8443`, `${WK} via light.example:8443`]);
});

test("an SRV target must name the requested domain", async () => {
  const fake = new Fake().answer(WK, 404, {}).srvRecords("_tavrn._tcp.home.example", [[10, 0, 443, "host.example"]]).answer(`${WK} via host.example:443`, 200, doc("host.example", "host.example"));
  await assert.rejects(run("home.example", fake), fail("resolve.invalid", "srv", "home.example"));
});

test("after a 404 without SRV the API on the domain is the last attempt", async () => {
  const fake = new Fake().answer(WK, 404, {}).answer("https://home.example/api/v1/node", 200, { name: "Home" });
  const found = await run("home.example", fake);
  assert.deepEqual([found.source, found.api, found.ws, found.web], ["domain", "https://home.example/api/v1", "wss://home.example/api/v1/ws", "https://home.example"]);
  await assert.rejects(run("home.example", new Fake().answer(WK, 404, {})), fail("resolve.not_found", "direct", "home.example"));
  await assert.rejects(run("home.example", new Fake().answer(WK, 404, {}).answer("https://home.example/api/v1/node", 200, [1])), fail("resolve.not_found", "direct", "home.example"));
});

test("without an HTTPS server: SRV, then unreachable, never the direct attempt", async () => {
  const fake = new Fake().fail(WK, "transport").srvRecords("_tavrn._tcp.home.example", [[10, 0, 443, "host.example"]]).answer(`${WK} via host.example:443`, 200, doc("home.example", "host.example"));
  assert.equal((await run("home.example", fake)).source, "srv");
  const down = new Fake().fail(WK, "transport");
  await assert.rejects(run("home.example", down), fail("resolve.unreachable", "srv", "home.example"));
  assert.ok(!down.fetched.some((u) => u.includes("/api/v1")), "no direct attempt without a 404");
});

test("other statuses and refused redirects stop at the well-known", async () => {
  for (const f of [new Fake().answer(WK, 500, {}), new Fake().answer(WK, 403, {}), new Fake().fail(WK, "refused")]) {
    await assert.rejects(run("home.example", f), fail("resolve.unreachable", "well_known", "home.example"));
    assert.deepEqual(f.srvAsked, []);
  }
});

test("invalid input", async () => {
  for (const bad of ["", "home", "home.example:8443", "1.2.3.4", "user@home.example", "-a.example", "a..example", "évil.example"]) {
    const fake = new Fake();
    await assert.rejects(run(bad, fake), (e: { code: string; step: string }) => e.code === "resolve.domain_invalid" && e.step === "input", bad);
    assert.deepEqual(fake.fetched, []);
  }
});

test("a development node on this computer over plain http, without SRV", async () => {
  const url = "http://127.0.0.1:8500/.well-known/tavrn";
  const local = { tavrn: 1, domain: "localhost", api: "http://127.0.0.1:8500/api/v1", ws: "ws://127.0.0.1:8500/api/v1/ws", web: "http://localhost:5500" };
  const found = await run("127.0.0.1:8500", new Fake().answer(url, 200, local));
  assert.deepEqual([found.domain, found.api, found.web], ["localhost", "http://127.0.0.1:8500/api/v1", "http://localhost:5500"]);
  const down = new Fake();
  await assert.rejects(run("localhost:8500", down), fail("resolve.unreachable", "well_known", "localhost:8500"));
  assert.deepEqual(down.srvAsked, []);
  // Plain http endpoints only on this computer, also for development nodes.
  const remote = { tavrn: 1, domain: "localhost", api: "http://evil.example/api/v1", ws: "ws://127.0.0.1:8500/api/v1/ws" };
  await assert.rejects(run("127.0.0.1:8500", new Fake().answer(url, 200, remote)), { code: "resolve.invalid" });
});

test("development hosts", () => {
  assert.ok(devHost("localhost:8080") && devHost("127.0.0.1") && devHost("127.0.0.1:8500"));
  for (const bad of ["127.0.0.2:80", "localhost:0", "localhost:99999", "evil.example:80", "localhost:", "localhost:8a"]) assert.ok(!devHost(bad), bad);
});

/** A local server: `route` answers each request; the requests are recorded. */
async function server(t: { after: (fn: () => void) => void }, route: (req: IncomingMessage, res: ServerResponse, port: number) => void) {
  const requests: IncomingMessage[] = [];
  const s = createServer((req, res) => {
    requests.push(req);
    route(req, res, (s.address() as AddressInfo).port);
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  t.after(() => s.close());
  return { port: (s.address() as AddressInfo).port, requests };
}

const nodeFetch: FetchLike = (url, init) => fetch(url, init);

test("the real fetcher reads a local node and names itself", async (t) => {
  const { port, requests } = await server(t, (_req, res, p) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ tavrn: 1, domain: "localhost", api: `http://127.0.0.1:${p}/api/v1`, ws: `ws://127.0.0.1:${p}/api/v1/ws` }));
  });
  const found = await resolveNode(`127.0.0.1:${port}`, new HttpFetcher(nodeFetch, "0.0.0-test"), { srv: async () => [] });
  assert.equal(found.api, `http://127.0.0.1:${port}/api/v1`);
  assert.equal(found.web, `http://127.0.0.1:${port}`, "no web: the API's origin");
  assert.equal(requests[0]?.url, "/.well-known/tavrn");
  assert.equal(requests[0]?.headers["user-agent"], "tavrn-desktop/0.0.0-test");
  assert.equal(requests[0]?.headers.accept, "application/json");
});

test("the real fetcher refuses redirects that leave https or the host, and oversized bodies", async (t) => {
  const { port } = await server(t, (req, res, p) => {
    if (req.url === "/to-http") return void res.writeHead(302, { Location: `http://127.0.0.1:${p}/x` }).end();
    if (req.url === "/to-other") return void res.writeHead(301, { Location: "https://evil.example/.well-known/tavrn" }).end();
    if (req.url === "/big") return void res.end("x".repeat(MAX_DOCUMENT + 1));
    res.end("{}");
  });
  const fetcher = new HttpFetcher(nodeFetch, "test");
  for (const path of ["/to-http", "/to-other", "/big"]) await assert.rejects(fetcher.get(`http://127.0.0.1:${port}${path}`), { kind: "refused" }, path);
  assert.equal((await fetcher.get(`http://127.0.0.1:${port}/ok`)).status, 200);
  // Nothing listens: no HTTP answer at all.
  await assert.rejects(fetcher.get("http://127.0.0.1:9/"), { kind: "transport" });
});

test("the real fetcher follows a few redirects on the same https host", async () => {
  let n = 0;
  const fake: FetchLike = async (url) => {
    n++;
    if (url.endsWith("/3")) return new Response("{}", { status: 200 });
    const next = Number(url.at(-1) ?? "0") + 1;
    return new Response(null, { status: 302, headers: { Location: `/${next}` } });
  };
  assert.equal((await new HttpFetcher(fake, "t").get("https://home.example/0")).status, 200);
  assert.equal(n, 4);
  const loop: FetchLike = async () => new Response(null, { status: 302, headers: { Location: "/again" } });
  await assert.rejects(new HttpFetcher(loop, "t").get("https://home.example/"), { kind: "refused" }, "at most 3 redirects");
});

/** A test CA and two server certificates (one for the identity domain, one for the SRV target only), made with openssl. */
function certificates(dir: string): { ca: string; domain: { key: string; cert: string }; target: { key: string; cert: string } } {
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=tavrn test CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign"], { cwd: dir, stdio: "pipe" });
  return { ca: readFileSync(join(dir, "ca.pem"), "utf8"), domain: leafWithSan(dir, "home.test"), target: leafWithSan(dir, "target.test") };
}

function leafWithSan(dir: string, name: string): { key: string; cert: string } {
  const ossl = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  ossl("req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${name}`, "-addext", `subjectAltName=DNS:${name}`);
  ossl("x509", "-req", "-in", `${name}.csr`, "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", `${name}.pem`, "-days", "2", "-copy_extensions", "copy");
  return { key: readFileSync(join(dir, `${name}.key`), "utf8"), cert: readFileSync(join(dir, `${name}.pem`), "utf8") };
}

test("the SRV step: the target's certificate must be valid for the identity domain", async (t) => {
  try {
    execFileSync("openssl", ["version"], { stdio: "pipe" });
  } catch {
    return t.skip("openssl is not installed");
  }
  const dir = mkdtempSync(join(tmpdir(), "tavrn-resolve-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const certs = certificates(dir);
  const serve = async (pair: { key: string; cert: string }) => {
    const hosts: string[] = [];
    const s = createTlsServer(pair, (req, res) => {
      hosts.push(String(req.headers.host));
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(doc("home.test", "node.home.test")));
    });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    t.after(() => s.close());
    return { port: (s.address() as AddressInfo).port, hosts };
  };
  const good = await serve(certs.domain);
  const impostor = await serve(certs.target);
  // The direct well-known fails (no HTTPS server for home.test here); the SRV record names 127.0.0.1's servers.
  const fetcher = new HttpFetcher(async () => Promise.reject(new TypeError("unreachable")), "test", { ca: [certs.ca], resolveTarget: () => "127.0.0.1" });
  const srvTo = (port: number): SrvLookup => ({ srv: async () => [{ priority: 0, weight: 0, port, target: "target.test" }] });
  // A certificate valid only for the SRV target (what a DNS spoofer can get): unreachable.
  await assert.rejects(resolveNode("home.test", fetcher, srvTo(impostor.port)), fail("resolve.unreachable", "srv", "home.test"));
  assert.deepEqual(impostor.hosts, [], "no request reaches a server without a certificate for the domain");
  // A certificate valid for the identity domain: found, asked with Host = the domain.
  const found = await resolveNode("home.test", fetcher, srvTo(good.port));
  assert.deepEqual([found.source, found.api], ["srv", "https://node.home.test/api/v1"]);
  assert.deepEqual(good.hosts, ["home.test"]);
});
