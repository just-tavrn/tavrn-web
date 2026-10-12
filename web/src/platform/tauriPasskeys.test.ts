// SPDX-License-Identifier: Apache-2.0
/** The Windows app's native passkeys (tauriPasskeys.ts): the shell's commands, its answers and its errors. */
import { describe, expect, it, vi } from "vitest";
import { nativePasskeys, nativeResult, passkeyError } from "./tauriPasskeys";

const credential = { id: "Y3JlZA", rawId: "Y3JlZA", type: "public-key", response: { clientDataJSON: "AQ" }, clientExtensionResults: { prf: { enabled: true } } };
const prf32 = "BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU";

describe("native passkeys of the Windows app", () => {
  it("pass the node's options to the shell's commands unchanged", async () => {
    const call = vi.fn(async () => ({ credential, prf: null }));
    const passkeys = nativePasskeys(call);
    const options = { publicKey: { challenge: "AAAA", rp: { id: "tavrn.org", name: "tavrn" } } };
    await passkeys.create(options);
    await passkeys.get({ publicKey: { challenge: "AAAA", rpId: "tavrn.org" } });
    expect(call).toHaveBeenNthCalledWith(1, "passkey_create", { options });
    expect(call).toHaveBeenNthCalledWith(2, "passkey_get", { options: { publicKey: { challenge: "AAAA", rpId: "tavrn.org" } } });
  });

  it("keep the PRF output apart, only as 32 bytes", () => {
    expect(nativeResult({ credential, prf: prf32 }).prf).toEqual(new Uint8Array(32).fill(5));
    expect(nativeResult({ credential, prf: "AQID" }).prf).toBeNull();
    expect(nativeResult({ credential, prf: "not base64url!" }).prf).toBeNull();
    expect(nativeResult({ credential, prf: null })).toEqual({ credential, prf: null });
  });

  it("refuse an answer without a credential id", () => {
    expect(() => nativeResult({ credential: {}, prf: null })).toThrow("passkey.failed");
    expect(() => nativeResult(null as never)).toThrow("passkey.failed");
  });

  it("turn the shell's codes into the errors a browser throws", async () => {
    expect(passkeyError("passkey.cancelled").name).toBe("NotAllowedError");
    expect(passkeyError("passkey.exists").name).toBe("InvalidStateError");
    expect(passkeyError("passkey.refused").name).toBe("SecurityError");
    expect(passkeyError("passkey.unavailable").name).toBe("NotSupportedError");
    expect(passkeyError("passkey.failed")).toMatchObject({ name: "Error", message: "passkey.failed" });
    const passkeys = nativePasskeys(vi.fn(async () => Promise.reject("passkey.cancelled")));
    await expect(passkeys.get({ publicKey: { challenge: "AAAA" } })).rejects.toMatchObject({ name: "NotAllowedError" });
  });
});
