// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from "react";
import type { AuthResponse, TavrnApi, TotpEnrollment } from "@tavrn/sdk";
import { useT } from "../../i18n";
import { describeError } from "../../stores/toasts";
import { defaultPasskeyName, registerPasskey, usePasskeyBlocker } from "../../lib/passkeys";
import { Button, ErrorText, Field, Input } from "../ui";
import { QrCode } from "./QrCode";

export interface EnrollResult {
  /** Only when enrolling with a pre-auth token. */
  session: AuthResponse | null;
  /** Only for the account's first factor. */
  recoveryCodes: string[] | null;
  passkey?: { credentialId: string; prf: Uint8Array | null; prfSupported: boolean };
}

/** Normalizes a typed 6-digit code (spaces allowed). */
export function cleanCode(code: string): string {
  return code.replace(/\s+/g, "");
}

/** TOTP enrollment: QR code of `otpauth_url` (rendered locally), the secret for manual entry, code check. */
export function TotpEnroll({ api, onDone, onCancel }: { api: TavrnApi; onDone: (r: EnrollResult) => void; onCancel?: () => void }) {
  const t = useT();
  const [data, setData] = useState<TotpEnrollment | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    api.auth.totpEnroll().then(setData, (e: unknown) => setError(describeError(e)));
  }, [api]);
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const r = await api.auth.totpConfirm(cleanCode(code));
          onDone({ session: r.session ?? null, recoveryCodes: r.recovery_codes ?? null });
        } catch (err) {
          setError(describeError(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="text-sm text-fg-1">{t("totp.intro")}</p>
      {data ? (
        <>
          <QrCode value={data.otpauth_url} label={t("totp.qr_label")} />
          <div className="space-y-1">
            <p className="text-xs text-fg-2">{t("totp.manual")}</p>
            <code className="block break-all rounded-md border border-line bg-bg-0 p-2 text-center font-mono text-sm tracking-wider select-all" data-testid="totp-secret">
              {data.secret}
            </code>
          </div>
        </>
      ) : (
        !error && <p className="text-sm text-fg-2">{t("common.loading")}</p>
      )}
      <Field label={t("totp.code")}>
        <Input name="totp_code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,8}" value={code} onChange={(e) => setCode(e.target.value)} required />
      </Field>
      <ErrorText>{error}</ErrorText>
      <div className="flex flex-wrap justify-end gap-2">
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            {t("common.back")}
          </Button>
        )}
        <Button type="submit" disabled={busy || !data}>
          {busy ? t("auth.wait") : t("totp.activate")}
        </Button>
      </div>
    </form>
  );
}

/** Passkey enrollment with a user-chosen name; requests the PRF so the passkey can unlock the secret storage. */
export function PasskeyEnroll({ api, onDone, onCancel, submitLabel }: { api: TavrnApi; onDone: (r: EnrollResult) => void; onCancel?: () => void; submitLabel?: string }) {
  const t = useT();
  const [name, setName] = useState(defaultPasskeyName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const blocker = usePasskeyBlocker();
  if (blocker === "pending") return <p className="text-sm text-fg-2">{t("common.loading")}</p>;
  if (blocker === "node") return <ErrorText>{t("passkey.app_origin_refused")}</ErrorText>;
  // The Linux app: passkeys on a security key only; the view switches as soon as one is plugged in.
  if (blocker === "key" || blocker === "key_access") {
    return (
      <div className="space-y-3">
        <p className="text-sm text-fg-1" role="status" data-testid="passkey-insert-key">
          {t(blocker === "key" ? "passkey.insert_key" : "passkey.key_no_access")}
        </p>
        {onCancel && (
          <div className="flex justify-end">
            <Button type="button" variant="ghost" onClick={onCancel}>
              {t("common.cancel")}
            </Button>
          </div>
        )}
      </div>
    );
  }
  if (blocker) return <ErrorText>{t("passkey.error.unsupported")}</ErrorText>;
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const r = await registerPasskey(api, name.trim());
          onDone({
            session: r.registered.session ?? null,
            recoveryCodes: r.registered.recovery_codes ?? null,
            passkey: { credentialId: r.registered.credential.id, prf: r.prf, prfSupported: r.prfSupported },
          });
        } catch (err) {
          setError(describeError(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="text-sm text-fg-1">{t("passkey.intro")}</p>
      <Field label={t("passkey.name")} hint={t("passkey.name_hint")}>
        <Input name="passkey_name" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} required />
      </Field>
      <ErrorText>{error}</ErrorText>
      <div className="flex flex-wrap justify-end gap-2">
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            {t("common.back")}
          </Button>
        )}
        <Button type="submit" disabled={busy || !name.trim()}>
          {busy ? t("auth.wait") : (submitLabel ?? t("passkey.create"))}
        </Button>
      </div>
    </form>
  );
}

/** Choice between authenticator app and passkey, then the chosen enrollment. */
export function SecondFactorEnroll({ api, onDone }: { api: TavrnApi; onDone: (r: EnrollResult) => void }) {
  const t = useT();
  const [method, setMethod] = useState<"totp" | "passkey" | null>(null);
  if (method === "totp") return <TotpEnroll api={api} onDone={onDone} onCancel={() => setMethod(null)} />;
  if (method === "passkey") return <PasskeyEnroll api={api} onDone={onDone} onCancel={() => setMethod(null)} />;
  return (
    <div className="space-y-3">
      <p className="text-sm text-fg-1">{t("second_factor.enroll_intro")}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <button type="button" onClick={() => setMethod("totp")} className="min-h-20 rounded-lg border border-line bg-bg-0 p-3 text-left hover:border-accent" data-testid="choose-totp">
          <span className="block text-sm font-medium">{t("second_factor.totp")}</span>
          <span className="block text-xs text-fg-2">{t("second_factor.totp_hint")}</span>
        </button>
        <button type="button" onClick={() => setMethod("passkey")} className="min-h-20 rounded-lg border border-line bg-bg-0 p-3 text-left hover:border-accent" data-testid="choose-passkey">
          <span className="block text-sm font-medium">{t("second_factor.passkey")}</span>
          <span className="block text-xs text-fg-2">{t("second_factor.passkey_hint")}</span>
        </button>
      </div>
    </div>
  );
}
