// SPDX-License-Identifier: Apache-2.0
// A tiny OpenID provider for the Playwright SSO specs (APPLICATIONS.md §8). Started by playwright.config.ts
// on 127.0.0.1:$E2E_OIDC_PORT; the e2e nodes run with `--dev`, which allows its `http://` issuer.
//
// - Discovery, JWKS (one RSA key generated at start), RS256 ID tokens with nonce, PKCE (S256) checked at
//   the token endpoint, client_secret_basic authentication, UserInfo and an end-session endpoint.
// - The authorization endpoint shows a sign-in form (username, display name, groups) instead of a real
//   login; the subject is `sub-<username>`, so the same username always is the same identity.
// Test-only code: no persistence, everything in memory.
import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const port = Number(process.env.E2E_OIDC_PORT ?? "8186");
const issuer = `http://127.0.0.1:${port}`;
export const CLIENT_ID = "tavrn-e2e";
const CLIENT_SECRET = "e2e-secret";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "e2e-1", use: "sig", alg: "RS256" };
const codes = new Map();
const tokens = new Map();

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const random = () => b64url(randomBytes(24));
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function idToken(claims) {
  const input = `${b64url(JSON.stringify({ alg: "RS256", kid: jwk.kid, typ: "JWT" }))}.${b64url(JSON.stringify(claims))}`;
  const signature = createSign("RSA-SHA256").update(input).sign(privateKey);
  return `${input}.${b64url(signature)}`;
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function body(req) {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 65536) throw new Error("too large");
  }
  return new URLSearchParams(data);
}

function loginForm(params) {
  const hidden = [...params].map(([k, v]) => `<input type="hidden" name="${escape(k)}" value="${escape(v)}">`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Fake IdP</title></head><body style="font-family:sans-serif;max-width:24rem;margin:2rem auto;padding:0 1rem">
<h1>Fake IdP sign-in</h1>
<form method="post" action="/authorize">${hidden}
<p><label>Username <input name="login_username" required autocomplete="off"></label></p>
<p><label>Display name <input name="login_name"></label></p>
<p><label>Groups <input name="login_groups" placeholder="devs, staff"></label></p>
<p><button type="submit">Sign in at the IdP</button> <button type="submit" name="deny" value="1" formnovalidate>Deny</button></p>
</form></body></html>`;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", issuer);
    if (req.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
      return json(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/jwks`,
        end_session_endpoint: `${issuer}/logout`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic"],
      });
    }
    if (req.method === "GET" && url.pathname === "/jwks") return json(res, 200, { keys: [jwk] });
    if (req.method === "GET" && url.pathname === "/authorize") {
      if (url.searchParams.get("client_id") !== CLIENT_ID || url.searchParams.get("code_challenge_method") !== "S256") {
        return json(res, 400, { error: "invalid_request" });
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(loginForm(url.searchParams));
    }
    if (req.method === "POST" && url.pathname === "/authorize") {
      const f = await body(req);
      const redirect = new URL(f.get("redirect_uri") ?? "");
      redirect.searchParams.set("state", f.get("state") ?? "");
      if (f.get("deny")) {
        redirect.searchParams.set("error", "access_denied");
      } else {
        const code = random();
        const username = (f.get("login_username") ?? "").trim();
        const groups = (f.get("login_groups") ?? "").split(",").map((g) => g.trim()).filter(Boolean);
        codes.set(code, { nonce: f.get("nonce"), challenge: f.get("code_challenge"), redirect: f.get("redirect_uri"), username, name: f.get("login_name") || username, groups });
        redirect.searchParams.set("code", code);
      }
      res.writeHead(302, { location: redirect.toString() });
      return res.end();
    }
    if (req.method === "POST" && url.pathname === "/token") {
      const basic = Buffer.from((req.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString();
      const [id, secret] = basic.split(":").map((p) => decodeURIComponent(p.replace(/\+/g, " ")));
      if (id !== CLIENT_ID || secret !== CLIENT_SECRET) return json(res, 401, { error: "invalid_client" });
      const f = await body(req);
      const entry = codes.get(f.get("code") ?? "");
      codes.delete(f.get("code") ?? "");
      const verifier = f.get("code_verifier") ?? "";
      if (!entry || entry.redirect !== f.get("redirect_uri") || b64url(createHash("sha256").update(verifier).digest()) !== entry.challenge) {
        return json(res, 400, { error: "invalid_grant" });
      }
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        iss: issuer, aud: CLIENT_ID, sub: `sub-${entry.username}`, iat: now, exp: now + 300, auth_time: now, nonce: entry.nonce,
        preferred_username: entry.username, name: entry.name, email: `${entry.username}@idp.test`, email_verified: true, groups: entry.groups,
      };
      const access = random();
      tokens.set(access, claims);
      return json(res, 200, { access_token: access, token_type: "Bearer", expires_in: 300, id_token: idToken(claims) });
    }
    if (req.method === "GET" && url.pathname === "/userinfo") {
      const claims = tokens.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
      return claims ? json(res, 200, { sub: claims.sub, preferred_username: claims.preferred_username, groups: claims.groups }) : json(res, 401, { error: "invalid_token" });
    }
    if (req.method === "GET" && url.pathname === "/logout") {
      const back = url.searchParams.get("post_logout_redirect_uri");
      res.writeHead(back ? 302 : 200, back ? { location: back } : { "content-type": "text/plain" });
      return res.end(back ? "" : "signed out");
    }
    json(res, 404, { error: "not_found" });
  } catch (e) {
    json(res, 400, { error: "invalid_request", error_description: String(e) });
  }
});

server.listen(port, "127.0.0.1", () => console.log(`fake OIDC provider on ${issuer}`));
