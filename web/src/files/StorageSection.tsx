// SPDX-License-Identifier: Apache-2.0
/**
 * "Storage" in the channel settings of a files channel (design note 4.13 item 9, FILES.md §5): internal storage
 * or an external WebDAV/S3 store, a connection test and the "encrypt files on the external store" toggle.
 * Only for members with `manage_channels` and `manage_files`; secrets are write-only (the node returns
 * whether one is stored, never the value).
 */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Permission, hasPermission, type BackendInfo, type BackendRequest, type Channel, type RoomDetail } from "@tavrn/sdk";
import { useT } from "../i18n";
import { useNode } from "../components/NodeScope";
import { Button, ErrorText, Field, Input } from "../components/ui";
import { Section, Select } from "../pages/settings/common";
import { describeError, useToasts } from "../stores/toasts";
import { channelPermissions } from "../pages/ChannelPage";

type Kind = "internal" | "webdav" | "s3";

interface Form {
  kind: Kind;
  url: string;
  username: string;
  password: string;
  access_key: string;
  secret_key: string;
  region: string;
  bucket: string;
  prefix: string;
  encrypt_files: boolean;
}

function formOf(b: BackendInfo): Form {
  return { kind: b.kind as Kind, url: b.url, username: b.username, password: "", access_key: b.access_key, secret_key: "", region: b.region, bucket: b.bucket, prefix: b.prefix, encrypt_files: b.encrypt_files };
}

/** The request for the node: only the fields of the chosen kind; empty secrets keep the stored ones. */
export function backendRequest(f: Form): BackendRequest {
  if (f.kind === "internal") return { kind: "internal" };
  const common = { kind: f.kind, url: f.url.trim(), prefix: f.prefix.trim() || null, encrypt_files: f.encrypt_files };
  if (f.kind === "webdav") return { ...common, username: f.username, password: f.password || null };
  return { ...common, access_key: f.access_key.trim(), secret_key: f.secret_key || null, region: f.region.trim() || null, bucket: f.bucket.trim() };
}

export function StorageSection({ room, channel }: { room: RoomDetail; channel: Channel }) {
  const t = useT();
  const { api, domain, me } = useNode();
  const queryClient = useQueryClient();
  const perms = channelPermissions(room, channel.id, me?.id ?? "");
  const allowed = hasPermission(perms, Permission.MANAGE_CHANNELS) && hasPermission(perms, Permission.MANAGE_FILES);
  const backend = useQuery({ queryKey: ["files-backend", domain, channel.id], queryFn: () => api.files.backend(room.id, channel.id), enabled: allowed });
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (backend.data) setForm(formOf(backend.data));
  }, [backend.data]);
  if (!allowed) return null;
  if (backend.isError) return <Section title={t("files.storage")}><ErrorText>{describeError(backend.error)}</ErrorText></Section>;
  if (!backend.data || !form) return null;
  const b = backend.data;
  const set = (patch: Partial<Form>) => {
    setForm({ ...form, ...patch });
    setTested(null);
  };
  const external = form.kind !== "internal";
  const locked = b.has_files;
  const run = async (action: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      if (done) useToasts.getState().push({ kind: "info", title: done });
      return true;
    } catch (e) {
      setError(describeError(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title={t("files.storage")} description={t("files.storage_hint")}>
      <div className="space-y-3" data-testid="files-storage">
        <Field label={t("files.storage_kind")} hint={locked ? t("files.storage_locked") : !b.external_allowed ? t("files.external_off") : undefined}>
          <Select value={form.kind} onChange={(e) => set({ kind: e.target.value as Kind })} data-testid="files-storage-kind">
            <option value="internal" disabled={locked && b.kind !== "internal"}>
              {t("files.backend.internal")}
            </option>
            <option value="webdav" disabled={!b.external_allowed || (locked && b.kind !== "webdav")}>
              {t("files.backend.webdav")}
            </option>
            <option value="s3" disabled={!b.external_allowed || (locked && b.kind !== "s3")}>
              {t("files.backend.s3")}
            </option>
          </Select>
        </Field>
        {external && (
          <>
            <Field label={form.kind === "webdav" ? t("files.webdav_url") : t("files.s3_endpoint")} hint={b.private_allowed ? undefined : t("files.https_only")}>
              <Input value={form.url} onChange={(e) => set({ url: e.target.value })} placeholder={form.kind === "webdav" ? "https://cloud.example.com/remote.php/dav/files/user/" : "https://s3.eu-central-1.amazonaws.com"} data-testid="files-storage-url" />
            </Field>
            {form.kind === "webdav" ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t("files.username")}>
                  <Input value={form.username} onChange={(e) => set({ username: e.target.value })} autoComplete="off" data-testid="files-storage-username" />
                </Field>
                <Field label={t("files.password")} hint={b.password_set ? t("files.secret_kept") : undefined}>
                  <Input type="password" value={form.password} onChange={(e) => set({ password: e.target.value })} autoComplete="new-password" placeholder={b.password_set ? "••••••••" : ""} data-testid="files-storage-password" />
                </Field>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t("files.bucket")}>
                  <Input value={form.bucket} onChange={(e) => set({ bucket: e.target.value })} data-testid="files-storage-bucket" />
                </Field>
                <Field label={t("files.region")}>
                  <Input value={form.region} onChange={(e) => set({ region: e.target.value })} placeholder="us-east-1" />
                </Field>
                <Field label={t("files.access_key")}>
                  <Input value={form.access_key} onChange={(e) => set({ access_key: e.target.value })} autoComplete="off" data-testid="files-storage-access-key" />
                </Field>
                <Field label={t("files.secret_key")} hint={b.secret_key_set ? t("files.secret_kept") : undefined}>
                  <Input type="password" value={form.secret_key} onChange={(e) => set({ secret_key: e.target.value })} autoComplete="new-password" placeholder={b.secret_key_set ? "••••••••" : ""} data-testid="files-storage-secret-key" />
                </Field>
              </div>
            )}
            <Field label={t("files.prefix")} hint={t("files.prefix_hint")}>
              <Input value={form.prefix} onChange={(e) => set({ prefix: e.target.value })} placeholder={`tavrn/${channel.id}/`} data-testid="files-storage-prefix" />
            </Field>
            {channel.encrypted ? (
              // End-to-end encrypted channels store the clients' ciphertext as it is (FILES.md §5).
              <p className="text-xs text-fg-2" data-testid="files-storage-e2ee">
                {t("files.storage_e2ee_hint")}
              </p>
            ) : (
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-0.5 h-4 w-4" checked={form.encrypt_files} onChange={(e) => set({ encrypt_files: e.target.checked })} data-testid="files-storage-encrypt" />
                <span>
                  {t("files.encrypt_external")}
                  <span className="block text-xs text-fg-2">{t("files.encrypt_external_hint")}</span>
                </span>
              </label>
            )}
          </>
        )}
        <ErrorText>{error}</ErrorText>
        {tested && <p className="text-sm text-success" role="status" data-testid="files-storage-test-ok">{t("files.test_ok")}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          {external && (
            <Button variant="ghost" disabled={busy} onClick={async () => setTested(await run(() => api.files.testBackend(room.id, channel.id, backendRequest(form))))} data-testid="files-storage-test">
              {t("files.test")}
            </Button>
          )}
          <Button
            disabled={busy}
            data-testid="files-storage-save"
            onClick={() =>
              void run(async () => {
                const fresh = await api.files.setBackend(room.id, channel.id, backendRequest(form));
                queryClient.setQueryData(["files-backend", domain, channel.id], fresh);
                void queryClient.invalidateQueries({ queryKey: ["files-usage", domain, channel.id] });
              }, t("files.storage_saved"))
            }
          >
            {t("common.save")}
          </Button>
        </div>
      </div>
    </Section>
  );
}
