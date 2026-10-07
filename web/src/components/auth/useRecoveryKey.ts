// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";
import { RecoveryKey } from "@tavrn/crypto";
import { ensureCrypto } from "@tavrn/e2ee";
import type { RecoveryKeyDisplay } from "./RecoveryKeyView";

/**
 * A fresh recovery key generated client side for as long as the component lives (ENCRYPTION.md §2.4).
 * It is never persisted; a reload simply generates a new one. Freed on unmount.
 */
export function useNewRecoveryKey(account: string, enabled = true): { key: RecoveryKey | null; display: RecoveryKeyDisplay | null; error: unknown } {
  const [state, setState] = useState<{ key: RecoveryKey | null; display: RecoveryKeyDisplay | null; error: unknown }>({ key: null, display: null, error: null });
  useEffect(() => {
    if (!enabled) return;
    let key: RecoveryKey | null = null;
    let alive = true;
    ensureCrypto().then(
      () => {
        if (!alive) return;
        key = RecoveryKey.generate();
        setState({ key, display: { words: key.toWords(), compact: key.toCompact(), file: key.toText(account) }, error: null });
      },
      (error: unknown) => alive && setState({ key: null, display: null, error }),
    );
    return () => {
      alive = false;
      key?.free();
    };
  }, [account, enabled]);
  return state;
}
