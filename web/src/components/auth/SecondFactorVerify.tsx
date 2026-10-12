// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import type { AuthResponse, TavrnApi } from "@tavrn/sdk";
import { useT } from "../../i18n";
import { describeError } from "../../stores/toasts";
import { passkeyLogin, usePasskeyBlocker } from "../../lib/passkeys";
import { Button, ErrorText, Field, Input } from "../ui";
import { cleanCode } from "./SecondFactorEnroll";

export interface VerifyResult {
  session: AuthResponse;
  /** Passkey ceremony only: the credential and its PRF output (if any), for unlocking. */
  passkey?: { credentialId: string; prf: Uint8Array | null };
}

/** Second step of the login: TOTP code, recovery code or passkey (PROTOCOL.md §5a.5). */
export function SecondFactorVerify({ api, preauthToken, methods, onSession, onCancel }: { api: TavrnApi; preauthToken: string; methods: string[]; onSession: (r: VerifyResult) => void; onCancel: () => void }) {
  const t = useT();
  const hasTotp = methods.includes("totp");
  const blocker = usePasskeyBlocker(methods.includes("webauthn"));
  const hasPasskey = methods.includes("webauthn") && blocker === null;
  // The Linux app: the passkey on a security key appears once the key is plugged in.
  const keyHint = methods.includes("webauthn") && (blocker === "key" || blocker === "key_access") ? t(blocker === "key" ? "verify.insert_key" : "passkey.key_no_access") : null;
  const [mode, setMode] = useState<"totp" | "recovery">(hasTotp ? "totp" : "recovery");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<VerifyResult>) => {
    setBusy(true);
    setError(null);
    try {
      onSession(await fn());
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => ({
            session: await api.auth.verifySecondFactor(mode === "totp" ? { preauth_token: preauthToken, totp_code: cleanCode(code) } : { preauth_token: preauthToken, recovery_code: code.trim() }),
          }));
        }}
      >
        <p className="text-sm text-fg-1">{mode === "totp" ? t("verify.totp_intro") : t("verify.recovery_intro")}</p>
        {mode === "totp" ? (
          <Field label={t("totp.code")}>
            <Input key="totp" name="totp_code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
          </Field>
        ) : (
          <Field label={t("verify.recovery_code")}>
            <Input key="recovery" name="recovery_code" autoComplete="off" spellCheck={false} placeholder="xxxx-xxxx-xxxx" value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
          </Field>
        )}
        <ErrorText>{error}</ErrorText>
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? t("auth.wait") : t("verify.submit")}
        </Button>
      </form>
      <div className="flex flex-col items-center gap-1 text-sm">
        {keyHint && (
          <p className="text-center text-xs text-fg-2" role="status" data-testid="verify-insert-key">
            {keyHint}
          </p>
        )}
        {hasPasskey && (
          <Button variant="ghost" disabled={busy} onClick={() => void run(async () => {
            const r = await passkeyLogin(api, { preauthToken });
            return { session: r.session, passkey: { credentialId: r.credentialId, prf: r.prf } };
          })}>
            {t("verify.use_passkey")}
          </Button>
        )}
        {hasTotp && (
          <button type="button" className="min-h-9 text-fg-2 hover:text-fg-0" onClick={() => { setMode(mode === "totp" ? "recovery" : "totp"); setCode(""); setError(null); }}>
            {mode === "totp" ? t("verify.use_recovery") : t("verify.use_totp")}
          </button>
        )}
        <button type="button" className="min-h-9 text-fg-2 hover:text-fg-0" onClick={onCancel}>
          {t("verify.cancel")}
        </button>
      </div>
    </div>
  );
}
