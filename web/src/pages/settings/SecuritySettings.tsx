// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import type { WebauthnCredential } from "@tavrn/sdk";
import { api } from "../../lib/api";
import { intlLocale, useT } from "../../i18n";
import { useAuth } from "../../stores/auth";
import { e2eeContext, useE2ee } from "../../stores/e2ee";
import { describeError, useToasts } from "../../stores/toasts";
import { useAction } from "../../hooks/useAction";
import { passkeyEntryIds, regenerateRecoveryKey, rotateIdentity } from "../../crypto/e2ee";
import { ownIdentityRotated } from "../../stores/mls";
import { cryptoStore } from "../../crypto/store";
import { enablePasskeyUnlock, offersEnable, passkeyUnlockState, windowsHello } from "../../lib/passkeyUnlock";
import { Button, Dialog, ErrorText, Field, Input } from "../../components/ui";
import { PasskeyEnroll, TotpEnroll, type EnrollResult } from "../../components/auth/SecondFactorEnroll";
import { RecoveryCodesView } from "../../components/auth/RecoveryCodes";
import { RecoveryKeyView } from "../../components/auth/RecoveryKeyView";
import { useNewRecoveryKey } from "../../components/auth/useRecoveryKey";
import { Section } from "./common";
import { useSso } from "../../components/auth/SsoButton";
import { startSso } from "../../lib/sso";

const info = (title: string) => useToasts.getState().push({ kind: "info", title });
const date = (s: string) => new Date(s).toLocaleString(intlLocale());

/** Security tab of the user settings: password, second factors, recovery codes, recovery key, lock on close. */
export function SecuritySettings() {
  const hasPassword = useAuth((s) => s.user?.has_password);
  return (
    <div className="space-y-4">
      <FactorsSection />
      <RecoveryCodesSection />
      <EncryptionSection />
      <SsoSection />
      {/* SSO-only accounts have no password (APPLICATIONS.md §8.3). */}
      {hasPassword !== false && <PasswordSection />}
    </div>
  );
}

function PasswordSection() {
  const t = useT();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        if (next !== repeat) return setError(t("auth.password_mismatch"));
        try {
          await api.users.changePassword({ current_password: current, new_password: next });
          setCurrent("");
          setNext("");
          setRepeat("");
          info(t("user.password_changed"));
        } catch (err) {
          setError(describeError(err));
        }
      }}
    >
      <Section title={t("user.password_change")}>
        <Field label={t("user.current_password")}>
          <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </Field>
        <Field label={t("user.new_password")} hint={t("auth.password_hint")}>
          <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
        </Field>
        <Field label={t("auth.password_repeat")}>
          <Input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} required />
        </Field>
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end">
          <Button type="submit">{t("common.save")}</Button>
        </div>
      </Section>
    </form>
  );
}

/**
 * Stores the new passkey's secret storage entry right away when the authenticator enabled the PRF and this device is
 * unlocked (`lib/passkeyUnlock.ts`); otherwise the list offers "Enable message unlock" for it later.
 */
async function storePasskeySecret(r: EnrollResult): Promise<boolean> {
  const pk = r.passkey;
  if (!pk?.prfSupported) return false;
  return (await enablePasskeyUnlock(pk.credentialId, pk.prf)) === "enabled";
}

function FactorsSection() {
  const t = useT();
  const queryClient = useQueryClient();
  const factors = useQuery({ queryKey: ["factors"], queryFn: () => api.auth.factors() });
  const [adding, setAdding] = useState<"totp" | "passkey" | null>(null);
  const [removeTotp, setRemoveTotp] = useState(false);
  const [removePasskey, setRemovePasskey] = useState<WebauthnCredential | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [enabling, setEnabling] = useState<string | null>(null);
  // Passkeys whose assertion gave no PRF output in this session: their reason is shown, the button stays.
  const [noPrfHere, setNoPrfHere] = useState<string[]>([]);
  const account = useAuth((s) => s.user?.address ?? "");
  const unlocked = useE2ee((s) => s.status) === "unlocked";
  // Which passkeys hold a secret storage entry: only those unlock the messages (ENCRYPTION.md §2.4).
  const entries = useQuery({ queryKey: ["secret-storage", "passkeys"], queryFn: () => passkeyEntryIds(api) });
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: ["factors"] }), queryClient.invalidateQueries({ queryKey: ["secret-storage", "passkeys"] })]);
  const windows = windowsHello();

  /**
   * "Enable message unlock": one PRF assertion with that passkey, then its entry (the node marks the credential as
   * PRF-capable with it, also when its registration announced no PRF).
   */
  const enable = async (c: WebauthnCredential) => {
    setEnabling(c.id);
    setError(null);
    try {
      const r = await enablePasskeyUnlock(c.id);
      setNoPrfHere((ids) => (r === "no_prf" ? [...ids.filter((id) => id !== c.id), c.id] : ids.filter((id) => id !== c.id)));
      if (r === "enabled") info(t("security.prf_enabled", { name: c.name }));
      else setError(r === "no_prf" ? t("security.prf_no_output", { name: c.name }) : t("security.prf_enable_locked"));
    } catch (e) {
      setError(describeError(e));
    } finally {
      setEnabling(null);
    }
    await refresh();
  };

  const enrolled = async (r: EnrollResult) => {
    setAdding(null);
    setError(null);
    if (r.recoveryCodes?.length) setCodes(r.recoveryCodes);
    let stored = false;
    try {
      stored = await storePasskeySecret(r);
    } catch (e) {
      setError(describeError(e));
    }
    info(r.passkey ? (stored ? t("security.passkey_added_unlock") : t("security.passkey_added")) : t("security.totp_added"));
    await refresh();
  };

  const f = factors.data;
  return (
    <Section title={t("security.factors")} description={t("security.factors_hint")}>
      {factors.isError && <ErrorText>{describeError(factors.error)}</ErrorText>}
      <ErrorText>{error}</ErrorText>
      <div className="flex min-h-12 flex-wrap items-center gap-2 border-b border-line pb-3 text-sm" data-testid="totp-row">
        <div className="min-w-0 flex-1">
          <p className="font-medium">{t("second_factor.totp")}</p>
          <p className="text-xs text-fg-2">{f ? (f.totp ? t("security.totp_on") : t("security.totp_off")) : t("common.loading")}</p>
        </div>
        {f?.totp && (
          <Button variant="ghost" onClick={() => { setError(null); setRemoveTotp(true); }}>
            {t("common.remove")}
          </Button>
        )}
        {f && !f.totp && adding !== "totp" && <Button variant="ghost" onClick={() => setAdding("totp")}>{t("security.totp_setup")}</Button>}
      </div>
      {adding === "totp" && <TotpEnroll api={api} onDone={(r) => void enrolled(r)} onCancel={() => setAdding(null)} />}

      <div>
        <p className="text-sm font-medium">{t("security.passkeys")}</p>
        <ul className="divide-y divide-line" data-testid="passkey-list">
          {f?.webauthn.map((c) => {
            const state = passkeyUnlockState(c, entries.data ?? null, noPrfHere);
            return (
              <li key={c.id} className="flex min-h-12 flex-wrap items-center gap-2 py-2 text-sm" data-testid="passkey-item" data-unlock={state ?? ""}>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium">{c.name}</span>
                    {state === "unlocks" && <span className="rounded bg-ok/15 px-1.5 text-xs text-ok" title={t("security.prf_hint")}>{t("security.prf_badge")}</span>}
                    {state === "enable" && <span className="rounded border border-line bg-bg-0 px-1.5 text-xs text-fg-1">{t("security.prf_can_enable")}</span>}
                    {state === "try" && <span className="rounded border border-line bg-bg-0 px-1.5 text-xs text-fg-1">{t("security.prf_try")}</span>}
                    {state === "unsupported" && <span className="rounded border border-line bg-bg-0 px-1.5 text-xs text-fg-1">{t("security.prf_none")}</span>}
                  </p>
                  <p className="text-xs text-fg-2">
                    {t("security.created", { date: date(c.created_at) })} · {c.last_used_at ? t("security.last_used", { date: date(c.last_used_at) }) : t("security.never_used")}
                  </p>
                  {state === "enable" && <p className="mt-1 text-xs text-fg-2">{unlocked ? t("security.prf_enable_hint") : t("security.prf_enable_locked")}</p>}
                  {(state === "try" || state === "unsupported") && (
                    <p className="mt-1 text-xs text-fg-2">
                      {state === "unsupported" ? t("security.prf_none_hint") : unlocked ? t("security.prf_try_hint") : t("security.prf_enable_locked")}
                      {windows && ` ${t("security.prf_none_windows")}`}
                    </p>
                  )}
                </div>
                {offersEnable(state) && (
                  <Button
                    variant="ghost"
                    className="border border-line"
                    aria-label={t("security.prf_enable_for", { name: c.name })}
                    disabled={!unlocked || enabling === c.id}
                    onClick={() => void enable(c)}
                    data-testid="passkey-enable-unlock"
                  >
                    {enabling === c.id ? t("auth.wait") : t("security.prf_enable")}
                  </Button>
                )}
                <Button variant="ghost" aria-label={t("security.passkey_remove", { name: c.name })} onClick={() => { setError(null); setRemovePasskey(c); }}>
                  {t("common.remove")}
                </Button>
              </li>
            );
          })}
          {f && f.webauthn.length === 0 && <li className="py-2 text-sm text-fg-2">{t("security.no_passkeys")}</li>}
        </ul>
      </div>
      {adding === "passkey" ? (
        <PasskeyEnroll api={api} submitLabel={t("security.passkey_add")} onDone={(r) => void enrolled(r)} onCancel={() => setAdding(null)} />
      ) : (
        <div className="flex justify-end">
          <Button variant="ghost" className="border border-line" onClick={() => setAdding("passkey")}>
            {t("security.passkey_add")}
          </Button>
        </div>
      )}

      {removeTotp && <RemoveTotpDialog open onClose={() => setRemoveTotp(false)} onRemoved={() => { setRemoveTotp(false); info(t("security.totp_removed")); void refresh(); }} />}
      <Dialog title={t("security.passkey_remove_title")} open={!!removePasskey} onClose={() => setRemovePasskey(null)}>
        <RemovePasskey
          credential={removePasskey}
          onClose={() => setRemovePasskey(null)}
          onRemoved={() => {
            setRemovePasskey(null);
            info(t("security.passkey_removed"));
            void refresh();
          }}
        />
      </Dialog>
      <Dialog title={t("codes.title")} open={!!codes} onClose={() => setCodes(null)}>
        {codes && <RecoveryCodesView codes={codes} account={account} onDone={() => setCodes(null)} doneLabel={t("common.done")} />}
      </Dialog>
    </Section>
  );
}

function RemovePasskey({ credential, onClose, onRemoved }: { credential: WebauthnCredential | null; onClose: () => void; onRemoved: () => void }) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!credential) return null;
  return (
    <div className="space-y-3 text-sm">
      <p className="text-fg-1">{t("security.passkey_remove_text", { name: credential.name })}</p>
      <ErrorText>{error}</ErrorText>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="danger"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await api.auth.deleteWebauthnCredential(credential.id);
              onRemoved();
            } catch (e) {
              setError(describeError(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {t("common.remove")}
        </Button>
      </div>
    </div>
  );
}

function RemoveTotpDialog({ open, onClose, onRemoved }: { open: boolean; onClose: () => void; onRemoved: () => void }) {
  const t = useT();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog title={t("security.totp_remove_title")} open={open} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            await api.auth.totpRemove({ password });
            onRemoved();
          } catch (err) {
            setError(describeError(err));
          }
        }}
      >
        <p className="text-sm text-fg-1">{t("security.totp_remove_text")}</p>
        <Field label={t("auth.password")}>
          <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="danger">
            {t("common.remove")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function RecoveryCodesSection() {
  const t = useT();
  const queryClient = useQueryClient();
  const factors = useQuery({ queryKey: ["factors"], queryFn: () => api.auth.factors() });
  const account = useAuth((s) => s.user?.address ?? "");
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setOpen(false);
    setCodes(null);
    setPassword("");
    setError(null);
    void queryClient.invalidateQueries({ queryKey: ["factors"] });
  };
  return (
    <Section title={t("security.codes")} description={t("security.codes_hint")}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <p className="flex-1" data-testid="codes-left">
          {factors.data ? t("security.codes_left", { count: factors.data.recovery_codes_left }) : t("common.loading")}
        </p>
        <Button variant="ghost" className="border border-line" onClick={() => setOpen(true)}>
          {t("security.codes_regenerate")}
        </Button>
      </div>
      <Dialog title={t("security.codes_regenerate")} open={open} onClose={close}>
        {codes ? (
          <RecoveryCodesView codes={codes} account={account} onDone={close} doneLabel={t("common.done")} />
        ) : (
          <form
            className="space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              setError(null);
              try {
                setCodes((await api.auth.regenerateRecoveryCodes(password)).recovery_codes);
                setPassword("");
              } catch (err) {
                setError(describeError(err));
              }
            }}
          >
            <p className="text-sm text-fg-1">{t("security.codes_regenerate_text")}</p>
            <Field label={t("auth.password")}>
              <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </Field>
            <ErrorText>{error}</ErrorText>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={close}>
                {t("common.cancel")}
              </Button>
              <Button type="submit">{t("security.codes_generate")}</Button>
            </div>
          </form>
        )}
      </Dialog>
    </Section>
  );
}

function EncryptionSection() {
  const t = useT();
  const user = useAuth((s) => s.user);
  const status = useE2ee((s) => s.status);
  const [lockOnClose, setLockOnClose] = useState<boolean | null>(null);
  const [regenerate, setRegenerate] = useState(false);
  const [rotate, setRotate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unlocked = status === "unlocked";
  useEffect(() => {
    void useE2ee.getState().refresh();
  }, []);
  useEffect(() => {
    if (user) cryptoStore.lockOnClose(user.address).then(setLockOnClose, () => setLockOnClose(false));
  }, [user, status]);
  if (!user) return null;
  const statusText = status === "unlocked" ? t("security.e2ee_unlocked") : status === "locked" ? t("security.e2ee_locked") : t("security.e2ee_none");
  return (
    <Section title={t("security.encryption")} description={t("security.encryption_hint")}>
      <dl className="grid gap-1 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-4">
        <dt className="text-fg-2">{t("user.address")}</dt>
        <dd className="break-all font-medium" data-testid="security-address">
          {user.address}
        </dd>
        <dt className="text-fg-2">{t("security.e2ee_status")}</dt>
        <dd data-testid="e2ee-status" data-status={status ?? ""}>
          {statusText}
          {!unlocked && (
            <>
              {" "}
              <Link to="/encryption?next=%2Fsettings%2Fsecurity" className="text-accent underline underline-offset-2 hover:text-accent-hover">
                {user.has_identity_key ? t("e2ee.banner_unlock_action") : t("e2ee.banner_setup_action")}
              </Link>
            </>
          )}
        </dd>
      </dl>
      <ErrorText>{error}</ErrorText>
      <div className="space-y-1 border-t border-line pt-3">
        <p className="text-sm font-medium">{t("security.recovery_key")}</p>
        <p className="text-xs text-fg-2">{t("security.recovery_key_hint")}</p>
        <div className="flex justify-end">
          <Button variant="ghost" className="border border-line" disabled={!unlocked} onClick={() => setRegenerate(true)}>
            {t("security.recovery_key_new")}
          </Button>
        </div>
      </div>
      <div className="space-y-1 border-t border-line pt-3" data-testid="identity-key-section">
        <p className="text-sm font-medium">{t("security.identity_key")}</p>
        <p className="text-xs text-fg-2">{t("security.identity_key_hint")}</p>
        <div className="flex flex-wrap justify-end gap-2">
          {user.has_identity_key && (
            <Link
              to="/encryption?reset=1&next=%2Fsettings%2Fsecurity"
              className="inline-flex min-h-10 items-center rounded-md px-3 text-sm text-danger hover:bg-danger/10"
              data-testid="identity-reset-link"
            >
              {t("security.identity_reset")}
            </Link>
          )}
          <Button variant="ghost" className="border border-line" disabled={!unlocked} onClick={() => setRotate(true)} data-testid="identity-rotate">
            {t("security.identity_rotate")}
          </Button>
        </div>
      </div>
      <label className="flex items-start gap-3 border-t border-line pt-3 text-sm">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4"
          data-testid="lock-on-close"
          checked={!!lockOnClose}
          disabled={!unlocked || lockOnClose === null}
          onChange={async (e) => {
            const on = e.target.checked;
            setError(null);
            setLockOnClose(on);
            try {
              await cryptoStore.setLockOnClose(on);
              info(on ? t("security.lock_on") : t("security.lock_off"));
            } catch (err) {
              setLockOnClose(!on);
              setError(describeError(err));
            }
          }}
        />
        <span>
          <span className="block font-medium">{t("security.lock_on_close")}</span>
          <span className="block text-xs text-fg-2">{t("security.lock_on_close_hint")}</span>
        </span>
      </label>
      <Dialog title={t("security.identity_rotate_title")} open={rotate} onClose={() => setRotate(false)}>
        {rotate && <RotateIdentity onCancel={() => setRotate(false)} onDone={() => { setRotate(false); info(t("security.identity_rotated")); }} />}
      </Dialog>
      <Dialog title={t("security.recovery_key_new")} open={regenerate} onClose={() => setRegenerate(false)}>
        {regenerate && <RegenerateRecoveryKey account={user.address} onDone={() => { setRegenerate(false); info(t("security.recovery_key_saved")); }} />}
      </Dialog>
    </Section>
  );
}

/**
 * Rotation of the identity key with continuity (ENCRYPTION.md §9a): explains the difference to the reset, then
 * rotates; the node asks for a fresh confirmation (re-auth dialog). The session manager reopens with the new key.
 */
function RotateIdentity({ onCancel, onDone }: { onCancel: () => void; onDone: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-3 text-sm" data-testid="identity-rotate-dialog">
      <p className="text-fg-1">{t("security.identity_rotate_text")}</p>
      <ul className="list-disc space-y-1 pl-5 text-xs text-fg-2">
        <li>{t("security.identity_rotate_point_contacts")}</li>
        <li>{t("security.identity_rotate_point_history")}</li>
        <li>{t("security.identity_rotate_point_reset")}</li>
      </ul>
      <ErrorText>{error}</ErrorText>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          {t("common.cancel")}
        </Button>
        <Button
          disabled={busy}
          data-testid="identity-rotate-confirm"
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await rotateIdentity(await e2eeContext());
              await ownIdentityRotated();
              onDone();
            } catch (e) {
              setError(describeError(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? t("security.identity_rotating") : t("security.identity_rotate_confirm")}
        </Button>
      </div>
    </div>
  );
}

function RegenerateRecoveryKey({ account, onDone }: { account: string; onDone: () => void }) {
  const t = useT();
  const rk = useNewRecoveryKey(account);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!rk.display || !rk.key) return <p className="text-sm text-fg-2">{t("common.loading")}</p>;
  const key = rk.key;
  return (
    <div className="max-h-[75vh] overflow-y-auto">
      <p className="mb-3 text-sm text-fg-1">{t("security.recovery_key_new_text")}</p>
      <RecoveryKeyView
        recoveryKey={rk.display}
        account={account}
        busy={busy}
        error={error}
        confirmLabel={t("security.recovery_key_save")}
        onConfirm={async () => {
          setBusy(true);
          setError(null);
          try {
            await regenerateRecoveryKey(await e2eeContext(), key);
            onDone();
          } catch (e) {
            setError(describeError(e));
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}

/**
 * Single sign-on (APPLICATIONS.md §8.3): link the provider identity to this signed-in account, or unlink
 * it (only while the account keeps a password and a second factor). Shown when this node has a provider
 * and the account lives here.
 */
function SsoSection() {
  const t = useT();
  const sso = useSso();
  const remoteHome = useAuth((s) => !!s.home);
  const qc = useQueryClient();
  const { run, busy, error } = useAction({ errors: "inline" });
  const enabled = !!sso && !remoteHome;
  const identity = useQuery({ queryKey: ["sso-identity"], queryFn: () => api.oidc.identity(), enabled });
  if (!enabled) return null;
  const linked = identity.data;
  return (
    <Section title={t("sso.section_title")} description={t("sso.section_hint")}>
      <div data-testid="sso-section" className="space-y-3">
        {identity.isLoading && <p className="text-sm text-fg-2">{t("common.loading")}</p>}
        {linked ? (
          <>
            <dl className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-4" data-testid="sso-linked">
              <dt className="text-fg-2">{t("sso.provider")}</dt>
              <dd className="break-all">{linked.issuer}</dd>
              <dt className="text-fg-2">{t("sso.linked_at")}</dt>
              <dd>{date(linked.linked_at)}</dd>
              {linked.last_login_at && (
                <>
                  <dt className="text-fg-2">{t("sso.last_login")}</dt>
                  <dd>{date(linked.last_login_at)}</dd>
                </>
              )}
            </dl>
            <div className="flex justify-end">
              <Button
                variant="ghost"
                className="border border-line"
                disabled={busy}
                data-testid="sso-unlink"
                onClick={() =>
                  void run(async () => {
                    await api.oidc.unlink();
                    await qc.invalidateQueries({ queryKey: ["sso-identity"] });
                    info(t("sso.unlinked_toast"));
                  })
                }
              >
                {t("sso.unlink")}
              </Button>
            </div>
          </>
        ) : (
          identity.isSuccess && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-fg-1">{t("sso.not_linked")}</p>
              <Button disabled={busy} data-testid="sso-link" onClick={() => void run(() => startSso(api, "link", "/settings/security"))}>
                {t("sso.link")}
              </Button>
            </div>
          )
        )}
        <ErrorText>{error}</ErrorText>
      </div>
    </Section>
  );
}
