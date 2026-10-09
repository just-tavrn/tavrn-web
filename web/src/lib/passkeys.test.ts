// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nodeInfo = vi.fn();
vi.mock("./api", () => ({ publicApi: { node: { info: () => nodeInfo() } } }));
vi.mock("@tavrn/e2ee", () => ({ ensureCrypto: async () => undefined }));
vi.mock("@tavrn/crypto", () => ({ secretStoragePrfInput: () => new Uint8Array(32).fill(7) }));

import { evaluatePrf, resetRelyingPartyId } from "./passkeys";

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
