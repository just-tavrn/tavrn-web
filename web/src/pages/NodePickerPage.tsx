// SPDX-License-Identifier: Apache-2.0
/**
 * `/node`, desktop app only (docs/DESKTOP.md "The node picker"): the home node this app talks to. Shown on the first
 * start for every path and later from Settings → App. Address first: `alice@home.example` (or just `home.example`)
 * names the account's node, which the shell finds as FEDERATION.md §1.4 says (well-known, SRV, direct; delegation
 * included). "Advanced: node URL" takes the node's address as it is opened in the browser (https only, no
 * credentials, no path; plain http only for a development node on this computer); the node must answer its discovery
 * document. The shell checks every address again before it persists it. Changing the node signs out of the old one
 * first.
 */
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { platform } from "../platform";
import type { NodeDetails } from "../platform";
import { checkNode, parseNodeUrl } from "../platform/nodeUrl";
import { baseOf, parseAppAccountInput, resolveErrorMessage } from "../lib/nodeAddress";
import { signOut } from "../stores/e2ee";
import { useAuth } from "../stores/auth";
import { describeError } from "../stores/toasts";
import { useT } from "../i18n";
import { AuthCard } from "../components/auth/AuthCard";
import { Button, ErrorText, Field, Input } from "../components/ui";

/** Replaceable pieces (tests). */
export const nodePickerDeps = {
  /** A full reload: every client, cache and connection starts over with the new node. */
  reload: (path: string) => location.assign(path),
  signOut: () => signOut(),
};

export function NodePickerPage() {
  const t = useT();
  const choice = platform().node;
  const current = choice?.current() ?? null;
  const signedIn = useAuth((s) => !!s.token);
  // Address first where the shell can resolve domains; the URL form stays as the advanced way.
  const byAddress = !!choice?.resolve;
  const [advanced, setAdvanced] = useState(!byAddress);
  // A deep link of another node names it (`DeepLinkPrompt`): the address starts with its domain.
  const [params] = useSearchParams();
  const suggested = (params.get("address") ?? "").slice(0, 254);
  const [address, setAddress] = useState(suggested);
  // The picker may already be open (the first start shows it for every path): a new suggestion replaces the field.
  useEffect(() => {
    if (suggested) setAddress(suggested);
  }, [suggested]);
  const [value, setValue] = useState(current ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** Persists the node (signing out of the old one first) and starts over at `path`. */
  const adopt = async (url: string, details: NodeDetails | undefined, path: string): Promise<boolean> => {
    if (!choice) return false;
    if (url === current && !details?.web) {
      nodePickerDeps.reload("/");
      return true;
    }
    // The session belongs to the old node: end it there before the client talks to the new one.
    if (current && signedIn && url !== current) await nodePickerDeps.signOut().catch(() => undefined);
    try {
      await (details && choice.domain ? choice.set(url, details) : choice.set(url));
    } catch {
      setError(t("node_picker.error.refused"));
      return false;
    }
    nodePickerDeps.reload(path);
    return true;
  };

  const submitAddress = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!choice?.resolve) return;
    setError(null);
    const parsed = parseAppAccountInput(address);
    if (!parsed) {
      setError(t("node_picker.address_invalid"));
      return;
    }
    setBusy(true);
    try {
      const found = await choice.resolve(parsed.domain);
      await adopt(baseOf(found), { domain: found.domain, web: found.web }, parsed.username ? `/login?username=${encodeURIComponent(parsed.username)}` : "/login");
    } catch (err) {
      setError(resolveErrorMessage(err, parsed.domain) ?? describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!choice) return;
    setError(null);
    const parsed = parseNodeUrl(value);
    if (!parsed.ok) {
      setError(t(`node_picker.error.${parsed.reason}`));
      return;
    }
    setBusy(true);
    try {
      const check = await checkNode(parsed.url);
      if (!check.ok) {
        setError(t(`node_picker.error.${check.reason}`));
        return;
      }
      if (parsed.url === current) {
        nodePickerDeps.reload("/");
        return;
      }
      await adopt(parsed.url, { domain: check.domain, web: check.web ?? parsed.url }, "/login");
    } finally {
      setBusy(false);
    }
  };

  const errorBox = (
    <div data-testid={error ? "node-picker-error" : undefined}>
      <ErrorText id="node-picker-error">{error}</ErrorText>
    </div>
  );

  return (
    <AuthCard nodeInfo={false}>
      <h1 className="text-base font-semibold">{t("node_picker.title")}</h1>
      <p className="mt-1 text-sm text-fg-2">{t(platform().android ? "node_picker.intro_android" : "node_picker.intro")}</p>
      {current && (
        <p className="mt-3 break-all text-xs text-fg-2" data-testid="node-picker-current">
          {t("node_picker.current", { url: current })}
        </p>
      )}
      {current && signedIn && (
        <p className="mt-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-fg-1" data-testid="node-picker-warning">
          {t("node_picker.change_warning")}
        </p>
      )}
      {byAddress && !advanced && (
        <form onSubmit={submitAddress} className="mt-4 space-y-3" noValidate>
          <Field label={t("node_picker.address_label")} hint={t("node_picker.address_hint")} errorId={error ? "node-picker-error" : undefined}>
            <Input name="address" type="text" inputMode="email" autoComplete="username" autoCapitalize="off" spellCheck={false} placeholder="alice@tavrn.example" value={address} onChange={(e) => setAddress(e.target.value)} required autoFocus />
          </Field>
          {errorBox}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? t("node_picker.finding") : t("node_picker.continue")}
          </Button>
          <button type="button" className="block min-h-9 w-full text-center text-sm text-fg-2 hover:text-fg-0" onClick={() => (setAdvanced(true), setError(null))} data-testid="node-picker-advanced">
            {t("node_picker.advanced")}
          </button>
        </form>
      )}
      {advanced && (
        <form onSubmit={submit} className="mt-4 space-y-3" noValidate>
          <Field label={t("node_picker.label")} hint={t("node_picker.hint")} errorId={error ? "node-picker-error" : undefined}>
            <Input name="node" type="url" inputMode="url" autoComplete="url" autoCapitalize="off" spellCheck={false} placeholder="https://tavrn.example" value={value} onChange={(e) => setValue(e.target.value)} required autoFocus />
          </Field>
          {errorBox}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? t("node_picker.checking") : t("node_picker.continue")}
          </Button>
        </form>
      )}
      {current && (
        <Link to="/settings/app" className="mt-2 block min-h-9 text-center text-sm leading-9 text-fg-2 hover:text-fg-0">
          {t("node_picker.cancel")}
        </Link>
      )}
    </AuthCard>
  );
}
