// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { api } from "../lib/api";
import { useT } from "../i18n";
import { homeIsRemote, useAuth } from "../stores/auth";
import { useAuthFlow } from "../stores/authFlow";
import { e2eeContext, isDeviceKeyLost, markDeviceLost, signOut, useE2ee } from "../stores/e2ee";
import { describeError } from "../stores/toasts";
import { passkeyEntryIds, resetIdentity, setupAccount, takePrf, unlockWithPasskeyPrf, unlockWithRecoveryKey } from "../crypto/e2ee";
import { evaluatePrf, passkeysSupported, usePasskeyBlocker } from "../lib/passkeys";
import { Button, ErrorText, Field, Input } from "../components/ui";
import { AuthCard } from "../components/auth/AuthCard";
import { BrandIcon } from "../components/auth/Brand";
import { Steps } from "../components/auth/Steps";
import { RecoveryKeyView } from "../components/auth/RecoveryKeyView";
import { useNewRecoveryKey } from "../components/auth/useRecoveryKey";
import { Textarea } from "./settings/common";
import { hasReauthToken, startSso, takeReauthToken, withReauthToken } from "../lib/sso";
import { useNodePageUnlock } from "../components/auth/NodePageHandoff";
import { cryptoStore, type BiometricState } from "../crypto/store";
import { unlockErrorCode } from "../platform/unlockError";

/** Set in sessionStorage when the user chose to continue without decryption in this tab. */
export const SKIP_UNLOCK_KEY = "tavrn.e2ee.skip";

export function skipUnlockChosen(): boolean {
  try {
    return sessionStorage.getItem(SKIP_UNLOCK_KEY) === "1";
  } catch {
    return false;
  }
}

type Mode = "loading" | "setup" | "unlock" | "reset" | "lost" | "biometric";

/**
 * After every sign-in and whenever this device cannot read encrypted data: sets up encryption for a new
 * account (recovery key, ENCRYPTION.md §2.4 flow 1), unlocks with the recovery key or a passkey (flow 2),
 * or resets the identity (§9). In the Android app it unlocks with fingerprint, face or PIN when that is on, and
 * offers to turn it on after any other unlock (docs/ANDROID.md "Unlock with fingerprint, face or PIN").
 */
export function EncryptionPage() {
  const t = useT();
  const token = useAuth((s) => s.token);
  const user = useAuth((s) => s.user);
  const setup = useAuthFlow((s) => s.setup);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = params.get("next") || "/";
  const [mode, setMode] = useState<Mode>("loading");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.users.me(), enabled: !!token });
  const decided = useRef(false);

  const done = () => {
    useAuthFlow.getState().setSetup(null);
    navigate(next.startsWith("/") && !next.startsWith("//") ? next : "/", { replace: true });
  };

  // Unlocked: the Android app offers the biometric unlock once the phone can and it is off (not with lock on close,
  // whose user wants nothing stored); everywhere else this is done().
  const finish = async () => {
    const address = useAuth.getState().user?.address;
    const state = address ? await cryptoStore.biometricState(address).catch(() => null) : null;
    if (state && state.available === "ready" && !state.on && !state.lockOnClose) setMode("biometric");
    else done();
  };

  useEffect(() => {
    if (!me.data || decided.current) return;
    decided.current = true;
    useAuth.getState().setUser(me.data);
    void (async () => {
      const status = await useE2ee.getState().refresh();
      // Back from the provider's confirmation of an identity reset (SSO accounts, APPLICATIONS.md §8.4).
      if (params.get("reset") === "sso" && hasReauthToken()) return setMode("reset");
      // A node that says "no identity key" while this device holds the account's master secret does not make it set up
      // anew (that would replace its local data): it unlocks. An unlocked store is an interrupted setup to finish.
      if (!me.data.has_identity_key) return setMode(status === "locked" ? "unlock" : "setup");
      // Opened from the security settings ("Reset security key", ENCRYPTION.md §9).
      if (params.get("reset") === "1") return setMode("reset");
      // The device's key is gone (tavrn-web#83): no unlock brings it back, the session signs in again as a new device.
      if (useE2ee.getState().deviceLost) return setMode("lost");
      if (status === "unlocked") return done();
      // A passkey used for this login may unlock right away (same ceremony, ENCRYPTION.md §2.4).
      const pending = takePrf();
      if (pending) {
        setBusy(true);
        try {
          await unlockWithPasskeyPrf(await e2eeContext(), pending.credentialId, pending.prf);
          useE2ee.getState().set("unlocked");
          return await finish();
        } catch (e) {
          if (isDeviceKeyLost(e)) {
            markDeviceLost();
            return setMode("lost");
          }
          /* no entry for this passkey or no PRF: ask for the recovery key */
        } finally {
          pending.prf.fill(0);
          setBusy(false);
        }
      }
      setMode("unlock");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me.data]);

  if (!token || !user) return <Navigate to="/login" replace />;

  const skip = () => {
    try {
      sessionStorage.setItem(SKIP_UNLOCK_KEY, "1");
    } catch {
      /* ignore */
    }
    done();
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      useAuth.getState().setUser(await api.users.me());
      useE2ee.getState().set("unlocked");
      await finish();
    } catch (e) {
      // The user closed the system's prompt of the biometric unlock (nothing to say), or Android discarded its key (the
      // unlock view explains that in its notice).
      if ((e as { name?: string }).name === "UnlockError" && ["cancelled", "invalidated"].includes(unlockErrorCode(e))) return;
      // The unlock worked, but this device's key is gone: it signs in again instead of asking for the key once more.
      if (isDeviceKeyLost(e)) {
        markDeviceLost();
        setMode("lost");
        return;
      }
      setError(describeError(e));
      // The account is set up already (local master secret or recovery entry): unlock instead.
      if ((e as { name?: string; code?: string }).name === "E2eeError" && (e as { code?: string }).code === "already_set_up") setMode("unlock");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard wide>
      {mode === "setup" && setup?.kind === "register" && <Steps current={4} />}
      <div className="mt-3 flex items-center gap-2">
        <BrandIcon size={28} />
        <h1 className="text-base font-semibold" data-testid="encryption-title">
          {mode === "setup"
            ? t("e2ee.setup_title")
            : mode === "reset"
              ? t("e2ee.reset_title")
              : mode === "lost"
                ? t("e2ee.device_lost_title")
                : mode === "biometric"
                  ? t("unlock.offer_title")
                  : t("e2ee.unlock_title")}
        </h1>
      </div>
      <p className="mt-1 break-all text-xs text-fg-2" data-testid="encryption-account">
        {user.address}
      </p>
      <div className="mt-3">
        {me.isError && <ErrorText>{describeError(me.error)}</ErrorText>}
        {mode === "loading" && !me.isError && <p className="text-sm text-fg-2">{busy ? t("e2ee.unlocking") : t("common.loading")}</p>}
        {mode === "setup" && <SetupView account={user.address} busy={busy} error={error} onConfirm={(fn) => void run(fn)} />}
        {mode === "unlock" && <UnlockView account={user.address} busy={busy} error={error} onRun={(fn) => void run(fn)} onReset={() => { setError(null); setMode("reset"); }} onSkip={skip} />}
        {mode === "biometric" && <BiometricOfferView account={user.address} onDone={done} />}
        {mode === "lost" && <DeviceLostView onSkip={skip} />}
        {mode === "reset" && <ResetView account={user.address} next={next} busy={busy} error={error} onRun={(fn) => void run(fn)} onBack={() => { setError(null); if (params.get("reset") === "1" && useE2ee.getState().status === "unlocked") done(); else setMode("unlock"); }} />}
      </div>
    </AuthCard>
  );
}

/**
 * This session's device lost its key (tavrn-web#83): a device key is immutable (ENCRYPTION.md §3.1), so neither the
 * recovery key nor a passkey makes this device readable again. Signing in again (the device is forgotten with its
 * local data) gives a new device that unlocks as usual.
 */
function DeviceLostView({ onSkip }: { onSkip: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-4" data-testid="device-lost">
      <p className="text-sm text-fg-1">{t("e2ee.device_lost_intro")}</p>
      <Button
        className="w-full"
        disabled={busy}
        data-testid="device-lost-sign-in"
        onClick={() => {
          setBusy(true);
          void signOut().finally(() => setBusy(false));
        }}
      >
        {t("e2ee.sign_in_again")}
      </Button>
      <div className="space-y-2 border-t border-line pt-3 text-sm">
        <button type="button" className="block min-h-9 text-left text-fg-2 hover:text-fg-0" onClick={onSkip} data-testid="skip-unlock">
          {t("e2ee.skip")}
        </button>
        <p className="text-xs text-fg-2">{t("e2ee.device_lost_skip_hint")}</p>
      </div>
    </div>
  );
}

function SetupView({ account, busy, error, onConfirm }: { account: string; busy: boolean; error: string | null; onConfirm: (fn: () => Promise<void>) => void }) {
  const t = useT();
  const rk = useNewRecoveryKey(account);
  if (rk.error) return <ErrorText>{describeError(rk.error)}</ErrorText>;
  if (!rk.display || !rk.key) return <p className="text-sm text-fg-2">{t("common.loading")}</p>;
  const key = rk.key;
  return (
    <div className="space-y-3">
      <p className="text-sm text-fg-1">{t("e2ee.setup_intro")}</p>
      <RecoveryKeyView
        recoveryKey={rk.display}
        account={account}
        busy={busy}
        error={error}
        confirmLabel={t("e2ee.setup_finish")}
        onConfirm={() =>
          onConfirm(async () => {
            const ctx = await e2eeContext();
            // A PRF passkey from the enrollment unlocks the secret storage as well.
            let passkey = takePrf();
            // Passkeys of another home node cannot be used on this origin (relying party = home domain).
            if (!passkey && passkeysSupported() && !homeIsRemote()) {
              const ids = (await api.auth.factors().catch(() => null))?.webauthn.filter((c) => c.prf_supported).map((c) => c.id) ?? [];
              if (ids.length) passkey = await evaluatePrf(ids).catch(() => null);
            }
            try {
              await setupAccount(ctx, key, passkey);
            } finally {
              passkey?.prf.fill(0);
            }
          })
        }
      />
    </div>
  );
}

/** The texts of the system's prompt of the biometric unlock. */
function promptTexts(t: ReturnType<typeof useT>, account: string, enable = false) {
  return { title: t(enable ? "unlock.enable_prompt_title" : "unlock.prompt_title"), subtitle: account };
}

/**
 * Android app, after an unlock: "Unlock with fingerprint, face or PIN next time?" Turning it on shows the system's
 * prompt (the keystore key works only after it); closing the prompt changes nothing.
 */
function BiometricOfferView({ account, onDone }: { account: string; onDone: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const turnOn = async () => {
    setBusy(true);
    setError(null);
    try {
      await cryptoStore.enableBiometric(promptTexts(t, account, true));
      onDone();
    } catch (e) {
      if (unlockErrorCode(e) !== "cancelled") setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4" data-testid="biometric-offer">
      <p className="text-sm text-fg-1">{t("unlock.offer_intro")}</p>
      <p className="text-xs text-fg-2">{t("unlock.offer_hint")}</p>
      <ErrorText>{error}</ErrorText>
      <Button className="w-full" disabled={busy} onClick={() => void turnOn()} data-testid="biometric-offer-on">
        {t("unlock.offer_on")}
      </Button>
      <Button variant="ghost" className="w-full border border-line" disabled={busy} onClick={onDone} data-testid="biometric-offer-skip">
        {t("unlock.offer_skip")}
      </Button>
    </div>
  );
}

/**
 * Android app: the biometric unlock of this account, read once (the store turns an invalidated one off on the way,
 * so a second read would no longer tell); its prompt opens by itself once when it is on.
 */
function useBiometricUnlock(account: string, busy: boolean, onRun: (fn: () => Promise<void>) => void) {
  const t = useT();
  const [state, setState] = useState<BiometricState | null>(null);
  const [invalidated, setInvalidated] = useState(false);
  const started = useRef(false);
  useEffect(() => {
    let live = true;
    cryptoStore.biometricState(account).then(
      (s) => {
        if (!live) return;
        setState(s);
        if (s?.invalidated) setInvalidated(true);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [account]);
  const available = !!state?.on && state.available === "ready" && !invalidated;
  const start = () =>
    onRun(async () => {
      try {
        await cryptoStore.unlockWithBiometric(account, promptTexts(t, account));
      } catch (e) {
        if (unlockErrorCode(e) === "invalidated") setInvalidated(true);
        throw e;
      }
    });
  useEffect(() => {
    if (available && !busy && !started.current) {
      started.current = true;
      start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available]);
  return { available, invalidated, start };
}

function UnlockView({ account, busy, error, onRun, onReset, onSkip }: { account: string; busy: boolean; error: string | null; onRun: (fn: () => Promise<void>) => void; onReset: () => void; onSkip: () => void }) {
  const t = useT();
  const [text, setText] = useState("");
  const biometric = useBiometricUnlock(account, busy, onRun);
  const remoteHome = useAuth((s) => s.home?.domain ?? null);
  const entries = useQuery({ queryKey: ["secret-storage", "passkeys"], queryFn: () => passkeyEntryIds(api), enabled: !remoteHome });
  // The desktop app has no WebAuthn of the node's domain: the passkey runs on the node's page (an unlock session).
  const onNodePage = useNodePageUnlock();
  // In the app itself where it can (the Windows app natively, the Android app when the node accepts its origin).
  const inApp = usePasskeyBlocker() === null;
  const canPasskey = !remoteHome && (inApp || onNodePage.available) && (entries.data?.length ?? 0) > 0;
  const unlockWith = (r: { credentialId: string; prf: Uint8Array }) =>
    onRun(async () => {
      try {
        await unlockWithPasskeyPrf(await e2eeContext(), r.credentialId, r.prf);
      } finally {
        r.prf.fill(0);
      }
    });
  if (onNodePage.view) return <>{onNodePage.view}</>;
  return (
    <div className="space-y-4">
      {biometric.available ? (
        <>
          <p className="text-sm text-fg-1">{t("unlock.intro")}</p>
          <Button className="w-full" disabled={busy} onClick={biometric.start} data-testid="unlock-biometric">
            {busy ? t("e2ee.unlocking") : t("unlock.with_biometric")}
          </Button>
          <p className="border-t border-line pt-3 text-sm text-fg-1">{t("unlock.or_recovery_key")}</p>
        </>
      ) : (
        <p className="text-sm text-fg-1">{t("e2ee.unlock_intro")}</p>
      )}
      {biometric.invalidated && (
        <p role="status" className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-fg-0" data-testid="unlock-biometric-invalidated">
          {t("unlock.invalidated")}
        </p>
      )}
      {/* PRF secrets are bound to the passkey's relying party, the home node's web address. */}
      {remoteHome && (
        <p className="rounded-md border border-line bg-bg-0 px-3 py-2 text-xs text-fg-1" data-testid="prf-origin-note">
          {t("e2ee.passkey_other_origin", { domain: remoteHome })}
        </p>
      )}
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          onRun(async () => {
            await unlockWithRecoveryKey(await e2eeContext(), text);
            setText("");
          });
        }}
      >
        <label className="block space-y-1 text-sm">
          <span className="text-fg-1">{t("e2ee.recovery_key_label")}</span>
          <Textarea name="recovery_key" rows={4} autoComplete="off" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("e2ee.recovery_key_placeholder")} data-testid="recovery-key-input" required />
        </label>
        <ErrorText>{error ?? onNodePage.error}</ErrorText>
        <Button type="submit" variant={biometric.available ? "ghost" : undefined} className={biometric.available ? "w-full border border-line" : "w-full"} disabled={busy || !text.trim()}>
          {busy ? t("e2ee.unlocking") : t("e2ee.unlock")}
        </Button>
      </form>
      {canPasskey && (
        <Button
          variant="ghost"
          className="w-full border border-line"
          disabled={busy}
          onClick={() =>
            !inApp && onNodePage.available
              ? onNodePage.start(unlockWith)
              : onRun(async () => {
                  const r = await evaluatePrf(entries.data ?? []);
                  if (!r) throw Object.assign(new Error("no prf"), { name: "E2eeError", code: "passkey_wrong" });
                  try {
                    await unlockWithPasskeyPrf(await e2eeContext(), r.credentialId, r.prf);
                  } finally {
                    r.prf.fill(0);
                  }
                })
          }
        >
          {t("e2ee.use_passkey")}
        </Button>
      )}
      <div className="space-y-2 border-t border-line pt-3 text-sm">
        <button type="button" className="block min-h-9 text-left text-fg-2 hover:text-fg-0" onClick={onSkip} data-testid="skip-unlock">
          {t("e2ee.skip")}
        </button>
        <p className="text-xs text-fg-2">{t("e2ee.skip_hint")}</p>
        <button type="button" className="block min-h-9 text-left text-danger hover:underline" onClick={onReset}>
          {t("e2ee.lost_key")}
        </button>
      </div>
    </div>
  );
}

function ResetView({ account, next, busy, error, onRun, onBack }: { account: string; next: string; busy: boolean; error: string | null; onRun: (fn: () => Promise<void>) => void; onBack: () => void }) {
  const t = useT();
  const [password, setPassword] = useState("");
  // SSO-only accounts confirm the reset with a fresh provider login instead of the password (§8.4).
  const ssoOnly = useAuth((s) => s.user?.has_password) === false;
  const [confirmed, setConfirmed] = useState(() => ssoOnly && hasReauthToken());
  const [ssoError, setSsoError] = useState<string | null>(null);
  const rk = useNewRecoveryKey(account, confirmed);
  return (
    <div className="space-y-3">
      <p className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-fg-0" data-testid="reset-warning">
        {t("e2ee.reset_warning")}
      </p>
      {!confirmed && ssoOnly ? (
        <div className="space-y-3">
          <p className="text-sm text-fg-1">{t("sso.reset_hint")}</p>
          <ErrorText>{ssoError}</ErrorText>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={onBack}>
              {t("common.back")}
            </Button>
            <Button
              variant="danger"
              data-testid="sso-reauth"
              onClick={() => startSso(api, "reauth", `/encryption?reset=sso&next=${encodeURIComponent(next)}`).catch((e) => setSsoError(describeError(e)))}
            >
              {t("sso.reset_confirm")}
            </Button>
          </div>
        </div>
      ) : !confirmed ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            setConfirmed(true);
          }}
        >
          <Field label={t("auth.password")}>
            <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={onBack}>
              {t("common.back")}
            </Button>
            <Button type="submit" variant="danger" disabled={!password}>
              {t("common.continue")}
            </Button>
          </div>
        </form>
      ) : rk.display && rk.key ? (
        <>
          <RecoveryKeyView
            recoveryKey={rk.display}
            account={account}
            busy={busy}
            error={error}
            confirmLabel={t("e2ee.reset_action")}
            onConfirm={() => {
              const key = rk.key!;
              onRun(async () => {
                const ctx = await e2eeContext();
                if (!ssoOnly) return resetIdentity(ctx, password, key);
                const token = takeReauthToken();
                if (!token) throw Object.assign(new Error("reauth expired"), { problem: { code: "sso.reauth_expired" } });
                await resetIdentity({ ...ctx, api: withReauthToken(ctx.api, token) }, "", key);
              });
            }}
          />
          <Button variant="ghost" className="w-full" disabled={busy} onClick={() => setConfirmed(false)}>
            {t("common.back")}
          </Button>
        </>
      ) : (
        <p className="text-sm text-fg-2">{t("common.loading")}</p>
      )}
    </div>
  );
}
