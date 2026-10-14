// SPDX-License-Identifier: Apache-2.0
/**
 * Which passkeys unlock the encrypted messages (ENCRYPTION.md §2.4). A passkey unlocks them when the secret storage
 * holds its `passkey:<credential id>` entry: the master secret wrapped under a key derived from the PRF output of that
 * passkey. The node's `prf_supported` of a credential says that the authenticator enabled the PRF extension when the
 * passkey was created, or that an entry was stored for it since (the node sets it with the entry); the entry is written
 * by the client, from an unlocked key store, after a PRF assertion with that passkey: at registration when the device
 * is unlocked, else later from Settings → Security ("Enable message unlock"). Some authenticators report the PRF only
 * when used (Windows Hello after a system update), so a passkey without the flag is offered the same button: one
 * assertion tells. Removing a passkey removes its entry on the node.
 */
import type { WebauthnCredential } from "@tavrn/sdk";
import { addPasskeySecret } from "../crypto/e2ee";
import { cryptoStore } from "../crypto/store";
import { e2eeContext } from "../stores/e2ee";
import { evaluatePrf } from "./passkeys";

/**
 * - `unlocks`: the secret storage holds this passkey's entry;
 * - `enable`: the authenticator enabled the PRF at registration, but no entry exists yet (the device was locked, or the
 *   assertion after the registration did not happen): "Enable message unlock" writes it;
 * - `try`: the registration announced no PRF and no entry exists: "Enable message unlock" tries one assertion, since
 *   some authenticators report the extension only when used or gain it with a system update;
 * - `unsupported`: an assertion with this passkey gave no PRF output here (this session): the reason, and the button
 *   stays for another try.
 */
export type PasskeyUnlockState = "unlocks" | "enable" | "try" | "unsupported";

/**
 * The state of passkey `c`: `entryIds` are the credential ids with a secret storage entry (null without the list: an
 * older node or a failed request, then only a passkey without the flag is certain to have none), `noPrfHere` the ids
 * whose assertion gave no PRF output in this session. Null when it cannot be told.
 */
export function passkeyUnlockState(
  c: Pick<WebauthnCredential, "id" | "prf_supported">,
  entryIds: readonly string[] | null,
  noPrfHere: readonly string[] = [],
): PasskeyUnlockState | null {
  if (entryIds?.includes(c.id)) return "unlocks";
  if (noPrfHere.includes(c.id)) return "unsupported";
  if (!c.prf_supported) return "try";
  return entryIds ? "enable" : null;
}

/** Whether the settings offer "Enable message unlock" for a passkey in `state`. */
export function offersEnable(state: PasskeyUnlockState | null): boolean {
  return state === "enable" || state === "try" || state === "unsupported";
}

/** `enabled`: the entry is stored; `locked`: nothing happened, the key store is locked; `no_prf`: the assertion gave no PRF output. */
export type EnablePasskeyUnlock = "enabled" | "locked" | "no_prf";

/**
 * Stores the secret storage entry of `credentialId`: with `prf` from the registration ceremony when the authenticator
 * returned one (the browser's `prf.results` at creation), else after a PRF assertion with exactly that passkey. Only
 * from an unlocked key store; the PRF output is wiped afterwards. A cancelled or failed assertion rejects as the
 * ceremony does (`describeError` explains it).
 */
export async function enablePasskeyUnlock(credentialId: string, prf: Uint8Array | null = null): Promise<EnablePasskeyUnlock> {
  if (!cryptoStore.isUnlocked()) return "locked";
  const output = prf ? { credentialId, prf } : await evaluatePrf([credentialId]);
  if (!output) return "no_prf";
  try {
    await addPasskeySecret(await e2eeContext(), output.credentialId, output.prf);
    return "enabled";
  } finally {
    output.prf.fill(0);
  }
}

/**
 * Whether the platform authenticator here is Windows Hello (a browser on Windows, or the Windows app's webview), whose
 * PRF support depends on the Windows build (docs/DESKTOP.md "Passkeys on Windows"): the settings add that reason.
 */
export function windowsHello(userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent): boolean {
  return /Windows NT/i.test(userAgent);
}
