// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";

const evaluatePrf = vi.fn();
const addPasskeySecret = vi.fn();
const isUnlocked = vi.fn();
vi.mock("./passkeys", () => ({ evaluatePrf: (ids: string[]) => evaluatePrf(ids) }));
vi.mock("../crypto/e2ee", () => ({ addPasskeySecret: (...a: unknown[]) => addPasskeySecret(...a) }));
vi.mock("../crypto/store", () => ({ cryptoStore: { isUnlocked: () => isUnlocked() } }));
vi.mock("../stores/e2ee", () => ({ e2eeContext: async () => ({ address: "a@t.local" }) }));

import { enablePasskeyUnlock, offersEnable, passkeyUnlockState, windowsHello } from "./passkeyUnlock";

beforeEach(() => {
  evaluatePrf.mockReset();
  addPasskeySecret.mockReset();
  isUnlocked.mockReset().mockReturnValue(true);
});

describe("passkeyUnlockState: what the settings say about each passkey (ENCRYPTION.md §2.4)", () => {
  it("unlocks messages only with its secret storage entry, whatever the node's prf_supported says", () => {
    expect(passkeyUnlockState({ id: "a", prf_supported: true }, ["a", "b"])).toBe("unlocks");
    // The flag alone (a wrap that was never stored: a locked device at registration, a cancelled assertion).
    expect(passkeyUnlockState({ id: "c", prf_supported: true }, ["a"])).toBe("enable");
  });

  it("a passkey whose registration announced no PRF is worth one try: some authenticators report it only when used", () => {
    expect(passkeyUnlockState({ id: "d", prf_supported: false }, [])).toBe("try");
    expect(passkeyUnlockState({ id: "d", prf_supported: false }, ["a"])).toBe("try");
  });

  it("an assertion here without a PRF output makes it unsupported (the reason), for this session only", () => {
    expect(passkeyUnlockState({ id: "d", prf_supported: false }, [], ["d"])).toBe("unsupported");
    // The flag said yes, the authenticator here gave no output (another platform, a hybrid phone): the reason too.
    expect(passkeyUnlockState({ id: "c", prf_supported: true }, [], ["c"])).toBe("unsupported");
    expect(passkeyUnlockState({ id: "c", prf_supported: true }, [], ["d"])).toBe("enable");
  });

  it("a stale entry of a passkey without the flag still counts (the entry is what unlocks)", () => {
    expect(passkeyUnlockState({ id: "d", prf_supported: false }, ["d"])).toBe("unlocks");
    expect(passkeyUnlockState({ id: "d", prf_supported: false }, ["d"], ["d"])).toBe("unlocks");
  });

  it("without the entry list (an older node, a failed request) only a passkey without the flag is certain to have none", () => {
    expect(passkeyUnlockState({ id: "c", prf_supported: true }, null)).toBeNull();
    expect(passkeyUnlockState({ id: "d", prf_supported: false }, null)).toBe("try");
    expect(passkeyUnlockState({ id: "d", prf_supported: false }, null, ["d"])).toBe("unsupported");
  });

  it("every state but unlocks offers the button: a failed try may succeed after a system update", () => {
    expect(offersEnable("enable")).toBe(true);
    expect(offersEnable("try")).toBe(true);
    expect(offersEnable("unsupported")).toBe(true);
    expect(offersEnable("unlocks")).toBe(false);
    expect(offersEnable(null)).toBe(false);
  });
});

describe("enablePasskeyUnlock: the wrap for one passkey", () => {
  it("runs the PRF assertion with that passkey only and stores the wrap, wiping the PRF output", async () => {
    const prf = new Uint8Array(32).fill(9);
    evaluatePrf.mockResolvedValue({ credentialId: "a", prf });
    expect(await enablePasskeyUnlock("a")).toBe("enabled");
    expect(evaluatePrf).toHaveBeenCalledWith(["a"]);
    expect(addPasskeySecret).toHaveBeenCalledWith({ address: "a@t.local" }, "a", expect.any(Uint8Array));
    expect(prf.every((b) => b === 0)).toBe(true);
  });

  it("uses the PRF output of the registration ceremony when the authenticator gave one (no second prompt)", async () => {
    const prf = new Uint8Array(32).fill(2);
    expect(await enablePasskeyUnlock("a", prf)).toBe("enabled");
    expect(evaluatePrf).not.toHaveBeenCalled();
    expect(addPasskeySecret).toHaveBeenCalledWith(expect.anything(), "a", expect.any(Uint8Array));
    expect(prf.every((b) => b === 0)).toBe(true);
  });

  it("never wraps from a locked key store, and says so without a prompt", async () => {
    isUnlocked.mockReturnValue(false);
    expect(await enablePasskeyUnlock("a")).toBe("locked");
    expect(evaluatePrf).not.toHaveBeenCalled();
    expect(addPasskeySecret).not.toHaveBeenCalled();
  });

  it("an assertion without a PRF output stores nothing", async () => {
    evaluatePrf.mockResolvedValue(null);
    expect(await enablePasskeyUnlock("a")).toBe("no_prf");
    expect(addPasskeySecret).not.toHaveBeenCalled();
  });

  it("a cancelled or failed assertion is the caller's to explain", async () => {
    evaluatePrf.mockRejectedValue(Object.assign(new Error("cancelled"), { name: "NotAllowedError" }));
    await expect(enablePasskeyUnlock("a")).rejects.toMatchObject({ name: "NotAllowedError" });
    expect(addPasskeySecret).not.toHaveBeenCalled();
  });
});

describe("windowsHello: where the platform authenticator is Windows Hello", () => {
  it("is the Windows user agents (browsers and the Windows app's webview), not others", () => {
    expect(windowsHello("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146.0 Safari/537.36 Edg/146.0")).toBe(true);
    expect(windowsHello("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/146.0")).toBe(false);
    expect(windowsHello("Mozilla/5.0 (Linux; Android 16; Pixel 8) AppleWebKit/537.36 Chrome/146.0 Mobile")).toBe(false);
  });
});
