// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nodeInfo = vi.fn();
vi.mock("./api", () => ({ publicApi: { node: { info: () => nodeInfo() } } }));
vi.mock("@tavrn/e2ee", () => ({ ensureCrypto: async () => undefined }));
vi.mock("@tavrn/crypto", () => ({ secretStoragePrfInput: () => new Uint8Array(32).fill(7) }));

import type { TavrnApi } from "@tavrn/sdk";
import { evaluatePrf, passkeyReauth, resetRelyingPartyId } from "./passkeys";

/** The `publicKey` options of the `n`-th `credentials.get` call. */
const optionsOf = (get: ReturnType<typeof vi.fn>, n: number) => (get.mock.calls[n]?.[0] as CredentialRequestOptions).publicKey!;

function prfCredential(id: string) {
  return { id, getClientExtensionResults: () => ({ prf: { results: { first: new Uint8Array(32).fill(1).buffer } } }) };
}

describe("evaluatePrf: the node's relying party id (PROTOCOL.md §5a.4)", () => {
  let get: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    resetRelyingPartyId();
    get = vi.fn(async () => prfCredential("cred-1"));
    Object.defineProperty(navigator, "credentials", { value: { get }, configurable: true });
  });
  afterEach(() => {
    nodeInfo.mockReset();
  });

  it("passes the relying party id the node publishes as rpId (delegation: a parent domain of the page's host)", async () => {
    nodeInfo.mockResolvedValue({ domain: "tavrn.test", webauthn: { rp_id: "tavrn.test" } });
    const r = await evaluatePrf(["AAAA"]);
    expect(r?.credentialId).toBe("cred-1");
    expect(get).toHaveBeenCalledTimes(1);
    expect(optionsOf(get, 0).rpId).toBe("tavrn.test");
  });

  it("asks the node once and reuses the id for later assertions", async () => {
    nodeInfo.mockResolvedValue({ webauthn: { rp_id: "tavrn.test" } });
    await evaluatePrf(["AAAA"]);
    await evaluatePrf(["AAAA"]);
    expect(nodeInfo).toHaveBeenCalledTimes(1);
    expect(optionsOf(get, 1).rpId).toBe("tavrn.test");
  });

  it("an older node without the field, or an unreachable one: the browser default (no rpId), and asks again next time", async () => {
    nodeInfo.mockResolvedValueOnce({ domain: "old.test" });
    await evaluatePrf(["AAAA"]);
    expect("rpId" in optionsOf(get, 0)).toBe(false);
    nodeInfo.mockRejectedValueOnce(new Error("offline"));
    await evaluatePrf(["AAAA"]);
    expect("rpId" in optionsOf(get, 1)).toBe(false);
    expect(nodeInfo).toHaveBeenCalledTimes(2);
  });
});

describe("passkeyReauth: one assertion for the re-authentication and the PRF (PROTOCOL.md §5c)", () => {
  const bytes = (n: number, fill: number) => new Uint8Array(n).fill(fill).buffer;
  const assertion = {
    id: "cred-1",
    rawId: bytes(4, 9),
    type: "public-key",
    authenticatorAttachment: "platform",
    response: { clientDataJSON: bytes(8, 1), authenticatorData: bytes(8, 2), signature: bytes(8, 3), userHandle: null },
    getClientExtensionResults: () => ({ prf: { results: { first: bytes(32, 5) } } }),
  };

  it("asks with the node's options (PRF requested), keeps the PRF output local and returns the reauth token", async () => {
    const get = vi.fn(async (_opts: CredentialRequestOptions) => assertion);
    Object.defineProperty(navigator, "credentials", { value: { get }, configurable: true });
    const reauth = vi.fn(async (_req: unknown) => ({ reauth_token: "fresh", expires_in: 300 }));
    const options = { publicKey: { challenge: "AAAA", allowCredentials: [], extensions: { prf: { eval: { first: "BwcH" } } } } };
    const api = { auth: { reauthWebauthnStart: vi.fn(async () => ({ challenge_id: "ch-1", options })), reauth } } as unknown as TavrnApi;
    const r = await passkeyReauth(api);
    expect(r.reauth.reauth_token).toBe("fresh");
    expect(r.credentialId).toBe("cred-1");
    expect(r.prf).toEqual(new Uint8Array(32).fill(5));
    const publicKey = (get.mock.calls[0]![0] as CredentialRequestOptions).publicKey!;
    expect(publicKey.extensions).toHaveProperty("prf.eval.first");
    const sent = reauth.mock.calls[0]![0] as { challenge_id: string; response: { clientExtensionResults: { prf?: object } } };
    expect(sent.challenge_id).toBe("ch-1");
    expect(sent.response.clientExtensionResults.prf).toEqual({});
    expect(JSON.stringify(sent)).not.toContain("results");
  });
});
