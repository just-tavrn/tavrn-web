// SPDX-License-Identifier: Apache-2.0
/**
 * Identity verification in the UI (FEDERATION.md §10): the "Verify" dialog with the safety number and
 * QR code, the verified badge, the notice when the key of a verified contact changed, and the marker
 * on plaintext messages whose device signature is missing or cannot be checked.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";
import { useAuth } from "../stores/auth";
import { useE2ee } from "../stores/e2ee";
import { acceptNewKey, dismissVerificationRefresh, getMls, markVerified, removeVerification, useMlsUi } from "../stores/mls";
import { toastError } from "../stores/toasts";
import { useAction } from "../hooks/useAction";
import type { PlainStatus } from "@tavrn/e2ee";
import { QrCode } from "./auth/QrCode";
import { Button, Dialog } from "./ui";
import { ShieldCheckIcon } from "./icons";

/** 60 digits as 12 groups of 5 (3 lines of 4 groups on screen). */
export function safetyNumberGroups(number: string): string[] {
  return Array.from({ length: Math.ceil(number.length / 5) }, (_, i) => number.slice(i * 5, i * 5 + 5));
}

/**
 * "verified" (✓), "verification broken" or "verification needs a refresh" (key rotated with continuity) next to a
 * user, from the verified contacts of this device. `compact`: the verified state as a small shield icon with the
 * accessible name and a tooltip, for member lists where the text chip truncated names (tavrn-web#121); the two
 * warning states keep their text everywhere.
 */
export function VerifiedBadge({ address, compact = false }: { address: string; compact?: boolean }) {
  const t = useT();
  const state = useMlsUi((s) => s.verification[address]);
  if (!state) return null;
  if (state === "broken") {
    return (
      <span className="rounded bg-danger/15 px-1 text-[10px] font-semibold text-danger" title={t("badge.verification_broken_hint", { address })} data-testid="verification-broken-badge">
        ⚠ {t("badge.verification_broken")}
      </span>
    );
  }
  // Rotated with continuity (ENCRYPTION.md §9a): soft and dismissable; the safety number verifies again.
  if (state === "refresh") {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void dismissVerificationRefresh(address);
        }}
        className="rounded bg-warn/10 px-1 text-[10px] font-medium text-fg-1 hover:bg-warn/20"
        title={t("badge.verification_refresh_hint", { address })}
        aria-label={`${t("badge.verification_refresh")}: ${t("badge.key_rotated_dismiss")}`}
        data-testid="verification-refresh-badge"
      >
        ↻ {t("badge.verification_refresh")} <span aria-hidden="true">×</span>
      </button>
    );
  }
  if (compact) {
    return (
      <span role="img" aria-label={t("badge.verified")} title={t("badge.verified_hint", { address })} className="inline-flex shrink-0 text-accent" data-testid="verified-badge" data-compact="true">
        <ShieldCheckIcon size={14} />
      </span>
    );
  }
  return (
    <span className="rounded bg-accent-soft px-1 text-[10px] font-semibold text-accent" title={t("badge.verified_hint", { address })} data-testid="verified-badge">
      ✓ {t("badge.verified")}
    </span>
  );
}

/** Small button that opens the verification dialog; hidden for the own account. */
export function VerifyButton({ address, name, className = "" }: { address: string; name?: string; className?: string }) {
  const t = useT();
  const me = useAuth((s) => s.user?.address);
  const [open, setOpen] = useState(false);
  if (!me || me === address) return null;
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        aria-label={t("safety.open", { name: name ?? address })}
        title={t("safety.open", { name: name ?? address })}
        className={`min-h-8 min-w-8 shrink-0 rounded text-fg-2 hover:bg-bg-3 hover:text-fg-0 ${className}`}
        data-testid="verify-button"
      >
        🛡
      </button>
      {open && createPortal(<VerifyDialog address={address} onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

type Info = { number: string; payload: string } | "unavailable" | "locked" | null;

/**
 * Safety number and QR code of the signed-in user and `address`, a field for a scanned or pasted code
 * of the other side, and the buttons to mark the contact as verified or remove the verification.
 */
export function VerifyDialog({ address, onClose }: { address: string; onClose: () => void }) {
  const t = useT();
  const status = useE2ee((s) => s.status);
  const state = useMlsUi((s) => s.verification[address]);
  const [info, setInfo] = useState<Info>(null);
  const [verifiedAt, setVerifiedAt] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const [result, setResult] = useState<"match" | "mismatch" | null>(null);
  const { run: act, busy } = useAction();

  useEffect(() => {
    let stale = false;
    void (async () => {
      const m = status === "unlocked" ? await getMls() : null;
      if (stale) return;
      if (!m) return setInfo("locked");
      try {
        const n = await m.safetyNumber(address);
        if (stale) return;
        setInfo(n ?? "unavailable");
        setVerifiedAt(m.verifiedContact(address)?.verified_at ?? null);
      } catch {
        if (!stale) setInfo("unavailable");
      }
    })();
    return () => {
      stale = true;
    };
  }, [address, status, state]);

  const compare = async () => {
    const m = await getMls();
    setResult(m?.comparePayload(address, pasted.trim()) ? "match" : "mismatch");
  };
  const run = (fn: () => Promise<unknown>, done: string) => act(fn, { done });
  const ready = info && typeof info === "object" ? info : null;
  const groups = ready ? safetyNumberGroups(ready.number) : [];

  return (
    <Dialog title={t("safety.title")} open onClose={onClose}>
      <div className="space-y-4 text-sm" data-testid="verify-dialog">
        <p className="break-all font-medium text-fg-0" data-testid="verify-address">
          {address}
        </p>
        {info === null && <p className="text-fg-2">{t("common.loading")}</p>}
        {info === "locked" && <p className="text-fg-2">{t("safety.locked")}</p>}
        {info === "unavailable" && <p className="text-fg-2">{t("safety.unavailable")}</p>}
        {ready && (
          <>
            <p className="text-fg-1">{t("safety.intro", { address })}</p>
            <p role="status" data-testid="verify-state" data-state={state ?? "unverified"} className={state === "broken" ? "rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-danger" : "text-fg-2"}>
              {state === "verified" ? t("safety.state_verified", { date: verifiedAt ? new Date(verifiedAt).toLocaleDateString() : "" }) : state === "broken" ? t("safety.state_broken") : state === "refresh" ? t("safety.state_refresh") : t("safety.state_unverified")}
            </p>
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-fg-2">{t("safety.number_label")}</p>
              <div role="group" className="grid grid-cols-4 gap-x-3 gap-y-1 rounded-md border border-line bg-bg-0 px-3 py-2 text-center font-mono text-base tracking-wider text-fg-0 sm:text-lg" data-testid="safety-number" aria-label={t("safety.number_label")}>
                {groups.map((g, i) => (
                  <span key={i}>{g}</span>
                ))}
              </div>
            </div>
            <QrCode value={ready.payload} label={t("safety.qr_label")} size={176} testId="verify-qr" />
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-fg-2" htmlFor="verify-own-code">
                {t("safety.own_code")}
              </label>
              <div className="flex gap-2">
                <input id="verify-own-code" readOnly value={ready.payload} onFocus={(e) => e.currentTarget.select()} className="min-h-10 w-full min-w-0 rounded-md border border-line-strong bg-bg-3 px-3 font-mono text-xs text-fg-1 outline-none" data-testid="verify-payload" />
                <Button variant="ghost" onClick={() => void navigator.clipboard?.writeText(ready.payload)}>
                  {t("common.copy")}
                </Button>
              </div>
            </div>
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (pasted.trim()) void compare();
              }}
            >
              <label className="block text-xs font-semibold uppercase tracking-wide text-fg-2" htmlFor="verify-paste">
                {t("safety.paste_label")}
              </label>
              <textarea
                id="verify-paste"
                rows={2}
                value={pasted}
                onChange={(e) => {
                  setPasted(e.target.value);
                  setResult(null);
                }}
                placeholder="tavrn:verify?v=1&…"
                className="w-full rounded-md border border-line-strong bg-bg-0 px-3 py-2 font-mono text-xs text-fg-0 outline-none focus:border-accent"
              />
              <Button type="submit" variant="ghost" disabled={!pasted.trim()}>
                {t("safety.compare")}
              </Button>
              {result && (
                <p role="status" data-testid="verify-result" data-result={result} className={result === "match" ? "rounded-md border border-accent/40 bg-accent-soft px-3 py-2 text-fg-0" : "rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-danger"}>
                  {result === "match" ? `✓ ${t("safety.match")}` : `⚠ ${t("safety.mismatch")}`}
                </p>
              )}
            </form>
            <div className="flex flex-wrap justify-end gap-2">
              {state === "verified" ? (
                <Button variant="ghost" disabled={busy} onClick={() => void run(() => removeVerification(address), t("safety.removed", { address }))}>
                  {t("safety.remove")}
                </Button>
              ) : (
                <Button disabled={busy || result === "mismatch"} onClick={() => void run(async () => {
                  if (!(await markVerified(address, result === "match" ? "qr" : "numeric"))) throw new Error(t("safety.unavailable"));
                }, t("safety.marked", { address }))}>
                  {t("safety.mark")}
                </Button>
              )}
              <Button variant="ghost" onClick={onClose}>
                {t("common.close")}
              </Button>
            </div>
          </>
        )}
        {!ready && (
          <div className="flex justify-end">
            <Button variant="ghost" onClick={onClose}>
              {t("common.close")}
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  );
}

/**
 * The key of a verified contact changed (§10.2). In DMs and group DMs sending is blocked until the
 * user verifies again or explicitly trusts the new key; in room channels it is a warning only.
 */
export function VerificationNotice({ addresses, blocking }: { addresses: string[]; blocking: boolean }) {
  const t = useT();
  const [verifying, setVerifying] = useState<string | null>(null);
  if (addresses.length === 0) return null;
  return (
    <div role="alert" data-testid="verification-notice" data-blocking={blocking} className="border-b border-danger/40 bg-danger/10 px-4 py-2 text-sm text-fg-0">
      <p className="font-semibold text-danger">⚠ {t("safety.notice_title")}</p>
      <ul className="mt-1 space-y-2">
        {addresses.map((a) => (
          <li key={a} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
            <span className="min-w-0 flex-1 break-all text-xs">{t(blocking ? "safety.notice_text_blocking" : "safety.notice_text", { address: a })}</span>
            <span className="flex flex-wrap gap-1">
              <Button variant="ghost" onClick={() => setVerifying(a)}>
                {t("safety.again")}
              </Button>
              <Button variant="danger" onClick={() => void acceptNewKey(a).catch(toastError)}>
                {t("safety.trust_new_key")}
              </Button>
            </span>
          </li>
        ))}
      </ul>
      {verifying && createPortal(<VerifyDialog address={verifying} onClose={() => setVerifying(null)} />, document.body)}
    </div>
  );
}

/** Marker of a plaintext message whose device signature is missing or cannot be checked. */
export function UnverifiedMarker({ status }: { status: PlainStatus }) {
  const t = useT();
  const hint = t(status === "unsigned" ? "messages.unverified_unsigned" : "messages.unverified_unknown");
  return (
    <span role="img" className="cursor-help rounded border border-line px-1 text-[10px] text-fg-2" title={hint} aria-label={`${t("messages.unverified")}: ${hint}`} data-testid="unverified-marker" data-status={status}>
      {t("messages.unverified")}
    </span>
  );
}
