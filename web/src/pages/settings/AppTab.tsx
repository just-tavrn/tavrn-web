// SPDX-License-Identifier: Apache-2.0
/**
 * Settings → App, desktop app only: version, the home node (node picker), the signed updates and their channel, where the keys of this
 * device are kept (OS keychain or the visible fallback), close to tray and quit.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { platform, type AvailableUpdate } from "../../platform";
import type { AppUpdater, UpdateChannel } from "../../platform/types";
import { useT } from "../../i18n";
import { describeError } from "../../stores/toasts";
import { Button, ErrorText, Field } from "../../components/ui";
import { Section, Select } from "./common";
import { cryptoStore } from "../../crypto";
import { useAuth } from "../../stores/auth";

type UpdateState = { kind: "idle" } | { kind: "checking" } | { kind: "current" } | { kind: "available"; update: AvailableUpdate } | { kind: "installing"; update: AvailableUpdate };

export function AppTab() {
  const t = useT();
  const p = platform();
  // The Android app downloads updates in the browser (docs/ANDROID.md "Updates") and has no tray.
  const android = !!p.android;
  const version = useQuery({ queryKey: ["app-version"], queryFn: () => p.appVersion(), staleTime: Infinity });
  const [state, setState] = useState<UpdateState>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);

  const check = async () => {
    if (!p.updater) return;
    setError(null);
    setState({ kind: "checking" });
    try {
      const update = await p.updater.check();
      setState(update ? { kind: "available", update } : { kind: "current" });
    } catch (e) {
      setError(describeError(e));
      setState({ kind: "idle" });
    }
  };

  const install = async (update: AvailableUpdate) => {
    setError(null);
    setState({ kind: "installing", update });
    try {
      // Restarts the app on success (Android: opens the download in the browser).
      await update.install();
      if (android) setState({ kind: "available", update });
    } catch (e) {
      setError(describeError(e));
      setState({ kind: "available", update });
    }
  };

  return (
    <div className="space-y-4">
      <Section title={t(android ? "android.section_title" : "desktop.section_title")}>
        <p className="text-sm text-fg-1" data-testid="app-version">
          {version.data ? t("desktop.version", { version: version.data }) : "…"}
        </p>
      </Section>
      <Section title={t("desktop.node")} description={t("desktop.node_hint")}>
        <p className="break-all font-mono text-sm text-fg-0" data-testid="app-node">
          {p.node?.current() ?? "—"}
        </p>
        <Link to="/node" className="inline-flex min-h-10 items-center rounded-md border border-line px-3 text-sm text-fg-0 hover:bg-bg-3">
          {t("desktop.change_node")}
        </Link>
      </Section>
      <Section title={t("desktop.updates")} description={p.updater ? t(android ? "android.updates_hint" : "desktop.updates_hint") : undefined}>
        {!p.updater ? (
          <p className="text-sm text-fg-2" data-testid="app-updates-unconfigured">
            {t("desktop.updates_unconfigured")}
          </p>
        ) : (
          <>
            {p.updater.channel && <ChannelField channel={p.updater.channel} onChange={() => setState({ kind: "idle" })} onError={setError} />}
            {state.kind === "current" && (
              <p role="status" className="text-sm text-fg-1" data-testid="app-up-to-date">
                {t("desktop.up_to_date")}
              </p>
            )}
            {(state.kind === "available" || state.kind === "installing") && (
              <div className="space-y-2" data-testid="app-update">
                <p role="status" className="text-sm font-semibold text-fg-0">
                  {t("desktop.update_available", { version: state.update.version })}
                </p>
                {state.update.notes && <p className="whitespace-pre-wrap text-xs text-fg-2">{state.update.notes}</p>}
                <Button disabled={state.kind === "installing"} onClick={() => void install(state.update)}>
                  {state.kind === "installing" && !android ? t("desktop.installing") : t(android ? "android.download_update" : "desktop.install_update")}
                </Button>
              </div>
            )}
            {state.kind !== "available" && state.kind !== "installing" && (
              <Button variant="ghost" className="border border-line" disabled={state.kind === "checking"} onClick={() => void check()}>
                {state.kind === "checking" ? t("desktop.checking") : t("desktop.check_updates")}
              </Button>
            )}
          </>
        )}
        <ErrorText>{error}</ErrorText>
      </Section>
      <KeysSection />
      <TraySection />
    </div>
  );
}

/** The update channel: stable (releases) or beta (pre-releases too); the shell keeps the choice. */
function ChannelField({ channel, onChange, onError }: { channel: NonNullable<AppUpdater["channel"]>; onChange: () => void; onError: (message: string | null) => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const current = useQuery({ queryKey: ["app-update-channel"], queryFn: () => channel.get(), retry: false });
  const [pending, setPending] = useState<UpdateChannel | null>(null);
  const choose = async (next: UpdateChannel) => {
    onError(null);
    setPending(next);
    try {
      await channel.set(next);
      onChange();
    } catch (e) {
      onError(describeError(e));
    }
    await queryClient.invalidateQueries({ queryKey: ["app-update-channel"] });
    setPending(null);
  };
  return (
    <Field label={t("desktop.update_channel")} hint={t("desktop.update_channel_hint")}>
      <Select value={pending ?? current.data ?? ""} disabled={!current.data || pending !== null} onChange={(e) => void choose(e.target.value as UpdateChannel)} data-testid="app-update-channel">
        {!current.data && <option value="">…</option>}
        <option value="stable">{t("desktop.update_channel_stable")}</option>
        <option value="beta">{t("desktop.update_channel_beta")}</option>
      </Select>
    </Field>
  );
}

/** Where the key that unlocks the local key store is: the OS keychain, or the fallback with a warning. */
function KeysSection() {
  const t = useT();
  const keystore = platform().keystore;
  const address = useAuth((s) => s.user?.address ?? null);
  const protection = useQuery({ queryKey: ["app-key-protection", address], queryFn: () => cryptoStore.keyProtection(address!), enabled: !!address });
  const status = useQuery({ queryKey: ["app-keychain"], queryFn: () => keystore!.status(), enabled: !!keystore, retry: false });
  if (!keystore || !address) return null;
  const backend = t(`desktop.backend.${status.data?.backend ?? "none"}`);
  return (
    <Section title={t("desktop.keys")}>
      <div data-testid="app-keys" data-protection={protection.data ?? "loading"} data-backend={status.data?.backend ?? ""}>
        {protection.data === "keychain" && <p className="text-sm text-fg-1">{t("desktop.keys_keychain", { backend })}</p>}
        {(protection.data === "fallback" || protection.data === "browser") && (
          <p role="alert" className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-fg-0" data-testid="app-keys-fallback">
            {t("desktop.keys_fallback")}
          </p>
        )}
        {protection.data === "lock_on_close" && <p className="text-sm text-fg-1">{t("desktop.keys_lock_on_close")}</p>}
        {protection.data === "none" && <p className="text-sm text-fg-2">{t("desktop.keys_none")}</p>}
      </div>
    </Section>
  );
}

/** Close to tray (persisted by the shell) and quit. */
function TraySection() {
  const t = useT();
  const tray = platform().android ? undefined : platform().tray;
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ["app-tray"], queryFn: () => tray!.status(), enabled: !!tray });
  const [error, setError] = useState<string | null>(null);
  // The switch follows the click at once; the shell's answer (or its refusal) settles it.
  const [pending, setPending] = useState<boolean | null>(null);
  if (!tray) return null;
  const toggle = async (on: boolean) => {
    setError(null);
    setPending(on);
    try {
      await tray.setCloseToTray(on);
    } catch (e) {
      setError(describeError(e));
    }
    await queryClient.invalidateQueries({ queryKey: ["app-tray"] });
    setPending(null);
  };
  return (
    <Section title={t("desktop.tray")}>
      {status.data?.available === false ? (
        <p className="text-sm text-fg-2" data-testid="app-tray-unavailable">
          {t("desktop.tray_unavailable")}
        </p>
      ) : (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 h-4 w-4" checked={pending ?? !!status.data?.closeToTray} disabled={!status.data} onChange={(e) => void toggle(e.target.checked)} data-testid="app-close-to-tray" />
          <span>
            {t("desktop.close_to_tray")}
            <span className="block text-xs text-fg-2">
              {t("desktop.close_to_tray_hint")} {t("desktop.tray_hint")}
            </span>
          </span>
        </label>
      )}
      <Button variant="ghost" className="border border-line" onClick={() => void tray.quit()} data-testid="app-quit">
        {t("desktop.quit")}
      </Button>
      <ErrorText>{error}</ErrorText>
    </Section>
  );
}
