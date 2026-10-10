// SPDX-License-Identifier: Apache-2.0
import { createSocket } from "node:dgram";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
// The @tavrn packages ship TypeScript sources: module hooks for this process and every worker (ts-packages.mjs).
import "./ts-packages.mjs";

// Starts tavrn nodes in development mode (main, single sign-on, legal and two federated ones), a fake OpenID
// provider and a Vite dev server per node, then runs the tests in Chromium, Firefox and WebKit plus phone/tablet
// emulations; retries in CI. The node under test is not built here (README.md "End-to-end tests"):
//   E2E_NODE_BIN    path of a tavrn-node binary (a debug build of tavrn-node, or copied out of its image),
//   E2E_NODE_IMAGE  a tavrn-node container image (for example ghcr.io/just-tavrn/tavrn-node:edge): every node runs
//                   in its own container with host networking, the same environment and ports, and the repository's
//                   data-dev/ mounted at the same path (the specs read keys and caches from there).
// When both are set the binary wins (the organization's e2e workflow copies it out of the image). With a binary,
// the node finds livekit-server (voice) and ffmpeg (media) on the PATH or through TAVRN_LIVEKIT_BINARY and
// TAVRN_MEDIA_FFMPEG; an image brings its own.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nodeBin = process.env.E2E_NODE_BIN?.trim() || undefined;
const nodeImage = process.env.E2E_NODE_IMAGE?.trim() || undefined;
if (!nodeBin && !nodeImage) {
  throw new Error("set E2E_NODE_BIN to a tavrn-node binary or E2E_NODE_IMAGE to a tavrn-node container image (README.md, \"End-to-end tests\")");
}
const tsHooks = `--import=${new URL("./ts-packages.mjs", import.meta.url).href}`;
if (!process.env.NODE_OPTIONS?.includes(tsHooks)) {
  process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, tsHooks, "--disable-warning=ExperimentalWarning"].filter(Boolean).join(" ");
}
// The node's SQLite databases and data directories (relative to the repository root), shared with the specs.
mkdirSync(resolve(root, "data-dev"), { recursive: true });
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The web server entry of one node: `tavrn-node --dev` with `env`, from E2E_NODE_BIN or as a container of
 * E2E_NODE_IMAGE (named after its port, removed when it stops; a leftover of an aborted run is removed first).
 */
function nodeServer(port: string, env: Record<string, string>) {
  const common = { cwd: root, url: `http://127.0.0.1:${port}/healthz`, reuseExistingServer: !ci, timeout: 300_000, env };
  if (nodeBin) return { ...common, command: `${shellQuote(nodeBin)} --dev` };
  const name = `tavrn-e2e-node-${port}`;
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const data = resolve(root, "data-dev");
  const vars = Object.keys(env).map((k) => `-e ${k}`).join(" ");
  return {
    ...common,
    command:
      `docker rm -f ${name} >/dev/null 2>&1; exec docker run --rm --name ${name} --network host --user ${uid}:${gid} ` +
      `-v ${shellQuote(`${data}:${data}`)} -w ${shellQuote(root)} ${vars} ${shellQuote(nodeImage!)} --dev`,
    // SIGTERM reaches the container through the docker client, so the node stops and the container is removed.
    gracefulShutdown: { signal: "SIGTERM" as const, timeout: 15_000 },
  };
}

const ci = !!process.env.CI;
// Ports can be overridden so that several checkouts can run the suite at the same time.
const nodePort = process.env.E2E_NODE_PORT ?? "8080";
const webPort = process.env.E2E_WEB_PORT ?? "5173";
const webOrigin = `http://localhost:${webPort}`;

// Federation (FEDERATION.md §13): two more nodes, `a.test` and `b.test`, each with its own web client.
// The browser resolves both names to 127.0.0.1 and treats their web origins as secure contexts
// (WebAuthn needs one), so the relying party id of a.test matches its web origin. By default the ports
// follow the main ones (+1 for b.test, +2 for a.test).
const plus = (port: string, n: number) => String(Number(port) + n);
export const fed = {
  nodePortA: process.env.E2E_NODE_PORT_A ?? plus(nodePort, 2),
  nodePortB: process.env.E2E_NODE_PORT_B ?? plus(nodePort, 1),
  webPortA: process.env.E2E_WEB_PORT_A ?? plus(webPort, 2),
  webPortB: process.env.E2E_WEB_PORT_B ?? plus(webPort, 1),
};
// Every node supervises its own livekit-server (tavrn-protocol/VOICE.md): signaling port = node port + 1000 and a
// UDP range of 150 ports derived from the node port, so the nodes of one run (and parallel checkouts with
// other ports) never collide. LiveKit takes a port per peer connection (two per participant) and frees it
// only some seconds after a participant left, so voice.spec.ts with two workers needs a few dozen.
// Without livekit-server installed set E2E_VOICE=false (README.md, "End-to-end tests").
const voiceEnabled = process.env.E2E_VOICE ?? "true";
/**
 * The machine's address on its default route (no packet is sent): LiveKit announces it as `node_ip`, which
 * is also where clients reach the embedded TURN server. Without it a development node picks its first
 * interface address, which can be one the browser cannot use (WSL puts 10.255.255.254 on `lo`).
 */
async function routeAddress(): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = createSocket("udp4");
    socket.on("error", () => resolve(null));
    socket.connect(9, "192.0.2.1", () => {
      const { address } = socket.address();
      socket.close();
      resolve(address);
    });
  });
}
const mediaAddress = process.env.E2E_MEDIA_IP ?? (await routeAddress());
const voiceEnv = (port: string) => {
  const base = 20000 + (Number(port) % 250) * 150;
  return {
    TAVRN_VOICE_ENABLED: voiceEnabled,
    TAVRN_LIVEKIT_PORT: plus(port, 1000),
    TAVRN_RTC_UDP_PORT_RANGE: `${base}-${base + 149}`,
    // Short reconnect grace period, so voice.spec.ts can watch a dropped participant leave (design note 4.5 item 7).
    TAVRN_VOICE_RECONNECT_GRACE_SECS: "5",
    // ICE over TCP and the embedded TURN server over UDP (VOICE.md §10), on ports derived from the node port
    // so parallel checkouts never collide; the connection test of voice.spec.ts tries every path.
    TAVRN_RTC_TCP_PORT: plus(port, 2000),
    TAVRN_RTC_TURN_ENABLED: "true",
    TAVRN_RTC_TURN_UDP_PORT: plus(port, 2100),
    TAVRN_RTC_TURN_TLS_PORT: "0",
    TAVRN_RTC_TURN_RELAY_PORT_RANGE: `${31000 + (Number(port) % 250) * 20}-${31000 + (Number(port) % 250) * 20 + 19}`,
    ...(mediaAddress ? { TAVRN_RTC_EXTERNAL_IP: mediaAddress } : {}),
  };
};
// Single sign-on (APPLICATIONS.md §8): a fake OpenID provider (e2e/fixtures/fake-oidc.mjs) that the main node
// trusts, and a node with TAVRN_OIDC_ONLY plus its own web client for the SSO-only login page (sso.spec.ts).
export const sso = {
  providerPort: process.env.E2E_OIDC_PORT ?? plus(nodePort, 4),
  nodePort: process.env.E2E_NODE_PORT_SSO ?? plus(nodePort, 5),
  webPort: process.env.E2E_WEB_PORT_SSO ?? plus(webPort, 5),
};
// Legal pages, terms and takedown notices (design note 4.14, legal.spec.ts): a node of its own, because published terms
// change the registration of every other spec. Ports follow the main ones (+6).
export const legal = {
  nodePort: process.env.E2E_NODE_PORT_LEGAL ?? plus(nodePort, 6),
  webPort: process.env.E2E_WEB_PORT_LEGAL ?? plus(webPort, 6),
};
const oidcEnv = { TAVRN_OIDC_ISSUER: `http://127.0.0.1:${sso.providerPort}`, TAVRN_OIDC_CLIENT_ID: "tavrn-e2e", TAVRN_OIDC_CLIENT_SECRET: "e2e-secret" };
const webA = `http://a.test:${fed.webPortA}`;
const webB = `http://b.test:${fed.webPortB}`;
// c.test is a node that never answers (port 9, nothing listens): the conformance spec checks and blocks it.
const devPeers = `a.test=http://127.0.0.1:${fed.nodePortA},b.test=http://127.0.0.1:${fed.nodePortB},c.test=http://127.0.0.1:9`;
const chromiumArgs = [`--host-resolver-rules=MAP a.test 127.0.0.1, MAP b.test 127.0.0.1`, `--unsafely-treat-insecure-origin-as-secure=${webA},${webB}`];
const federationSpecs = /(federation.*|discover|conformance)\.spec\.ts/;

function fedNode(domain: "a.test" | "b.test", port: string, web: string) {
  const name = domain.split(".")[0];
  return nodeServer(port, {
    TAVRN_DOMAIN: domain,
    TAVRN_LISTEN: `127.0.0.1:${port}`,
    // Delegation (design note 4.2c, delegation.spec.ts): the identity domain a.test is served on another host.
    // Its well-known (reached through the development peer mapping and the browser's host mapping) names
    // `http://127.0.0.1:<port>` as API and WebSocket endpoint, so every client and peer follows the delegation.
    ...(domain === "a.test" ? { TAVRN_PUBLIC_URL: `http://127.0.0.1:${port}` } : {}),
    TAVRN_DATABASE_URL: `sqlite://data-dev/e2e-${name}.db?mode=rwc`,
    TAVRN_DATA_DIR: `data-dev/e2e-${name}`,
    TAVRN_WEBAUTHN_ORIGIN: web,
    TAVRN_FEDERATION_ALLOW_PRIVATE: "true",
    TAVRN_FEDERATION_DEV_PEERS: devPeers,
    // Directory (FEDERATION.md §7): b.test announces itself to a.test, the reference node of the tests.
    TAVRN_REFERENCE_NODES: domain === "b.test" ? "a.test" : "",
    // Conformance (FEDERATION.md §9): the admin of a.test runs checks; a high login limit makes the
    // `rate.limits` check skip its burst, so checks never throttle the federated logins of other specs.
    TAVRN_ADMIN_USERS: "fedadmin",
    TAVRN_FEDERATION_RATE_LOGINS: "1000",
    // Executables (PROTOCOL.md §7a) are refused by default, as on the main node; b.test allows them (and their content
    // type) so that upload-policy.spec.ts can upload one and check the warning before it is downloaded.
    ...(domain === "b.test"
      ? { TAVRN_UPLOAD_ALLOW_EXECUTABLES: "true", TAVRN_UPLOAD_ALLOWED_TYPES: "image/*,video/*,audio/*,application/pdf,text/plain,application/zip,application/x-msdownload" }
      : {}),
    ...voiceEnv(port),
  });
}

function fedWeb(nodePortOf: string, port: string) {
  return {
    command: "pnpm --filter @tavrn/web dev",
    cwd: root,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !ci,
    timeout: 120_000,
    env: { E2E_NODE_PORT: nodePortOf, E2E_WEB_PORT: port, E2E_WEB_HOST: "127.0.0.1", E2E_ALLOWED_HOSTS: ".test" },
  };
}

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  // The suite starts real crypto (Argon2id, MLS) per test; more workers than this make it flaky on a loaded machine.
  workers: ci ? 2 : 4,
  forbidOnly: ci,
  retries: ci ? 2 : 0,
  reporter: ci ? [["github"], ["html", { open: "never" }]] : "list",
  // Assertions wait up to 10 s (default 5 s): on a loaded machine Argon2id, MLS joins and passkey
  // ceremonies take longer; the crypto-heavy steps of the specs wait up to 20 s explicitly.
  expect: { timeout: 10_000 },
  use: {
    baseURL: webOrigin,
    locale: "de-DE",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], launchOptions: { args: chromiumArgs } } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] }, testIgnore: federationSpecs },
    { name: "webkit", use: { ...devices["Desktop Safari"] }, testIgnore: federationSpecs },
    { name: "mobile-android", use: { ...devices["Pixel 7"], launchOptions: { args: chromiumArgs } } },
    { name: "mobile-ios", use: { ...devices["iPhone 15"] }, testIgnore: federationSpecs },
    { name: "tablet", use: { ...devices["iPad (gen 7)"] }, testIgnore: federationSpecs },
    // Tablet layout in Chromium for the sign-in flows across nodes and single sign-on (they need Chromium; the WebKit tablet
    // above skips them) and the accessibility gate (a11y.spec.ts). Run with `--project=tablet-chromium`.
    { name: "tablet-chromium", use: { ...devices["Galaxy Tab S4 landscape"], launchOptions: { args: chromiumArgs } }, testMatch: /(federation-(login|e2ee)|sso|a11y)\.spec\.ts/ },
  ],
  webServer: [
    // WebAuthn: the browser runs on the Vite origin, the relying party id stays the node domain (localhost).
    nodeServer(nodePort, { TAVRN_LISTEN: `127.0.0.1:${nodePort}`, TAVRN_DATABASE_URL: "sqlite://data-dev/e2e.db?mode=rwc", TAVRN_DATA_DIR: "data-dev/e2e", TAVRN_ADMIN_USERS: "e2eadmin", TAVRN_WEBAUTHN_ORIGIN: webOrigin, ...oidcEnv, ...voiceEnv(nodePort) }),
    {
      command: "node fixtures/fake-oidc.mjs",
      url: `http://127.0.0.1:${sso.providerPort}/.well-known/openid-configuration`,
      reuseExistingServer: !ci,
      timeout: 30_000,
      env: { E2E_OIDC_PORT: sso.providerPort },
    },
    nodeServer(sso.nodePort, {
        TAVRN_LISTEN: `127.0.0.1:${sso.nodePort}`,
        TAVRN_DATABASE_URL: "sqlite://data-dev/e2e-sso.db?mode=rwc",
        TAVRN_DATA_DIR: "data-dev/e2e-sso",
        TAVRN_WEBAUTHN_ORIGIN: `http://localhost:${sso.webPort}`,
        TAVRN_ADMIN_USERS: "ssoadmin",
        TAVRN_OIDC_ONLY: "true",
        TAVRN_VOICE_ENABLED: "false",
        ...oidcEnv,
    }),
    {
      command: "pnpm --filter @tavrn/web dev",
      cwd: root,
      url: `http://localhost:${sso.webPort}`,
      reuseExistingServer: !ci,
      timeout: 120_000,
      env: { E2E_NODE_PORT: sso.nodePort, E2E_WEB_PORT: sso.webPort },
    },
    {
      command: "pnpm --filter @tavrn/web dev",
      cwd: root,
      url: webOrigin,
      reuseExistingServer: !ci,
      timeout: 120_000,
      env: { E2E_NODE_PORT: nodePort, E2E_WEB_PORT: webPort },
    },
    nodeServer(legal.nodePort, {
        TAVRN_LISTEN: `127.0.0.1:${legal.nodePort}`,
        TAVRN_DATABASE_URL: "sqlite://data-dev/e2e-legal.db?mode=rwc",
        TAVRN_DATA_DIR: "data-dev/e2e-legal",
        TAVRN_WEBAUTHN_ORIGIN: `http://localhost:${legal.webPort}`,
        TAVRN_ADMIN_USERS: "legaladmin",
        TAVRN_LEGAL_NOTICES: "on",
        TAVRN_VOICE_ENABLED: "false",
    }),
    {
      command: "pnpm --filter @tavrn/web dev",
      cwd: root,
      url: `http://localhost:${legal.webPort}`,
      reuseExistingServer: !ci,
      timeout: 120_000,
      env: { E2E_NODE_PORT: legal.nodePort, E2E_WEB_PORT: legal.webPort },
    },
    fedNode("a.test", fed.nodePortA, webA),
    fedNode("b.test", fed.nodePortB, webB),
    fedWeb(fed.nodePortA, fed.webPortA),
    fedWeb(fed.nodePortB, fed.webPortB),
  ],
});
