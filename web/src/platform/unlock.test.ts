// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { UnlockError, createAndroidUnlock, unlockErrorCode } from "./unlock";

/** The shell's commands of the biometric unlock (`src-tauri/src/android.rs`), with a fake IPC. */
function fakeShell(answers: Record<string, unknown> = {}, refuse: Record<string, string> = {}) {
  const calls: [string, unknown][] = [];
  const call = async (cmd: string, args?: unknown) => {
    calls.push([cmd, args]);
    if (refuse[cmd]) throw refuse[cmd];
    return answers[cmd];
  };
  return { calls, unlock: createAndroidUnlock(call) };
}

const PROMPT = { title: "Unlock tavrn", subtitle: "alice@tavrn.example" };

describe("the Android app's biometric unlock commands", () => {
  it("passes the account, the secret as bytes and the prompt's texts", async () => {
    const { calls, unlock } = fakeShell({ android_unlock_status: { available: "ready", stored: "none" }, android_unlock_get: Array(32).fill(5) });
    expect(await unlock.status("alice@tavrn.example")).toEqual({ available: "ready", stored: "none" });
    await unlock.store("alice@tavrn.example", new Uint8Array(32).fill(3), PROMPT);
    expect(await unlock.get("alice@tavrn.example", PROMPT)).toEqual(new Uint8Array(32).fill(5));
    await unlock.clear("alice@tavrn.example");
    await unlock.status();
    expect(calls).toEqual([
      ["android_unlock_status", { account: "alice@tavrn.example" }],
      ["android_unlock_store", { account: "alice@tavrn.example", secret: Array(32).fill(3), prompt: PROMPT }],
      ["android_unlock_get", { account: "alice@tavrn.example", prompt: PROMPT }],
      ["android_unlock_clear", { account: "alice@tavrn.example" }],
      ["android_unlock_status", { account: null }],
    ]);
  });

  it("turns the shell's refusals into UnlockErrors with a known code", async () => {
    const { unlock } = fakeShell({}, { android_unlock_get: "unlock.cancelled", android_unlock_store: "unlock.invalidated", android_unlock_clear: "android.failed" });
    const code = (p: Promise<unknown>) => p.then(() => "resolved", (e: unknown) => (e instanceof UnlockError ? e.code : `not an UnlockError: ${String(e)}`));
    expect(await code(unlock.get("a@x", PROMPT))).toBe("cancelled");
    expect(await code(unlock.store("a@x", new Uint8Array(32), PROMPT))).toBe("invalidated");
    expect(await code(unlock.clear("a@x"))).toBe("failed");
  });

  it("refuses an answer that is not a 32-byte key", async () => {
    const { unlock } = fakeShell({ android_unlock_get: [1, 2, 3] });
    await expect(unlock.get("a@x", PROMPT)).rejects.toMatchObject({ name: "UnlockError", code: "failed" });
  });

  it("knows only its own codes", () => {
    expect(unlockErrorCode("unlock.lockout")).toBe("lockout");
    expect(unlockErrorCode(new Error("unlock.busy"))).toBe("busy");
    expect(unlockErrorCode("unlock.anything")).toBe("failed");
    expect(unlockErrorCode("keychain.unavailable")).toBe("failed");
    expect(unlockErrorCode(undefined)).toBe("failed");
    expect(unlockErrorCode(new UnlockError("none"))).toBe("none");
  });
});
