// SPDX-License-Identifier: Apache-2.0
/**
 * `/node`, desktop app only (docs/DESKTOP.md "The node picker"): the home node this app talks to. Shown on the first
 * start for every path and later from Settings → App. The address is checked here (https only, no credentials, no
 * path; plain http only for a development node on this computer), the node must answer its discovery document,
 * and the shell checks the address again before it persists it. Changing the node signs out of the old one first.
 */
import { useState } from "react";
import { Link } from "react-router";
import { platform } from "../platform";
import { checkNode, parseNodeUrl } from "../platform/nodeUrl";
import { signOut } from "../stores/e2ee";
import { useAuth } from "../stores/auth";
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
  const [value, setValue] = useState(current ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      // The session belongs to the old node: end it there before the client talks to the new one.
      if (current && signedIn) await nodePickerDeps.signOut().catch(() => undefined);
      try {
        await choice.set(parsed.url);
      } catch {
        setError(t("node_picker.error.refused"));
        return;
      }
      nodePickerDeps.reload("/login");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard nodeInfo={false}>
      <h1 className="text-base font-semibold">{t("node_picker.title")}</h1>
      <p className="mt-1 text-sm text-fg-2">{t("node_picker.intro")}</p>
      {current && (
        <p className="mt-3 break-all text-xs text-fg-2" data-testid="node-picker-current">
          {t("node_picker.current", { url: current })}
        </p>
      )}
      <form onSubmit={submit} className="mt-4 space-y-3" noValidate>
        <Field label={t("node_picker.label")} hint={t("node_picker.hint")} errorId={error ? "node-picker-error" : undefined}>
          <Input name="node" type="url" inputMode="url" autoComplete="url" autoCapitalize="off" spellCheck={false} placeholder="https://tavrn.example" value={value} onChange={(e) => setValue(e.target.value)} required autoFocus />
        </Field>
        {current && signedIn && (
          <p className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-fg-1" data-testid="node-picker-warning">
            {t("node_picker.change_warning")}
          </p>
        )}
        <div data-testid={error ? "node-picker-error" : undefined}>
          <ErrorText id="node-picker-error">{error}</ErrorText>
        </div>
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? t("node_picker.checking") : t("node_picker.continue")}
        </Button>
        {current && (
          <Link to="/settings/app" className="block min-h-9 text-center text-sm leading-9 text-fg-2 hover:text-fg-0">
            {t("node_picker.cancel")}
          </Link>
        )}
      </form>
    </AuthCard>
  );
}
