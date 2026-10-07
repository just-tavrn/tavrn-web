// SPDX-License-Identifier: Apache-2.0
/**
 * Browser bindings of the shared encryption module `@tavrn/e2ee` (session manager, codecs, account
 * flows): `cryptoStore` is the IndexedDB `KeyStore` of this browser (with "lock on close"), the flows in
 * `./e2ee` run on it and keep the passkey PRF output of a WebAuthn login until it unlocked the account.
 */
export { ensureCrypto } from "@tavrn/e2ee";
export { CryptoStore, LocalKeyMismatchError, cryptoStore, type CryptoStatus } from "./store";
export {
  CLIENT_STATE,
  E2eeError,
  KEY_PACKAGE_BATCH,
  KEY_PACKAGE_MIN,
  addPasskeySecret,
  ensureDevice,
  forgetIdentityKeepDevice,
  localIdentityKey,
  loadClient,
  localStatus,
  passkeyEntryIds,
  regenerateRecoveryKey,
  resetIdentity,
  rotateIdentity,
  syncIdentity,
  saveClient,
  setupAccount,
  unlockWithPasskeyPrf,
  unlockWithRecoveryKey,
  wipeLocal,
  type E2eeContext,
  type E2eeErrorCode,
} from "./e2ee";
