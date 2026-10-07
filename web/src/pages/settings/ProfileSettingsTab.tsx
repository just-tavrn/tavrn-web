// SPDX-License-Identifier: Apache-2.0
/**
 * Profile settings (design note 4.9): display name, avatar and header uploads (converted by the node: the
 * avatar is cropped to a square, the header to 1200 × 400 — no manual cropping), bio and linked accounts.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Profile, ProfileLinkInput } from "@tavrn/sdk";
import { api } from "../../lib/api";
import { renderMarkdown } from "../../lib/markdown";
import { useT } from "../../i18n";
import { useAuth } from "../../stores/auth";
import { describeError, toastError, useToasts } from "../../stores/toasts";
import { MediaAvatar } from "../../components/Avatar";
import { Button, ErrorText, Field, Input } from "../../components/ui";
import { Section, Select, Textarea } from "./common";
import { IdleSection } from "./IdleSection";
import { MyDataSection } from "./AccountDataSections";

export const LINK_SERVICES = ["steam", "battlenet", "xbox", "playstation", "nintendo", "twitch", "youtube", "x", "mastodon", "website"] as const;
export const BIO_MAX = 512;
export const LINKS_MAX = 10;
/** The node refuses larger uploads; checked here first to save the upload. */
export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
const ACCEPT = "image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm";

function useOwnProfile() {
  const address = useAuth((s) => s.user?.address ?? "");
  return useQuery({ queryKey: ["profile", "me", address], queryFn: () => api.users.profile(address), enabled: !!address });
}

export function ProfileSettingsTab() {
  const t = useT();
  const profile = useOwnProfile();
  if (profile.isPending) return <p className="text-sm text-fg-2">{t("common.loading")}</p>;
  if (profile.isError) return <ErrorText>{describeError(profile.error)}</ErrorText>;
  return (
    <div className="space-y-4">
      <AboutSection profile={profile.data} />
      <ImagesSection profile={profile.data} />
      <IdleSection />
      <MyDataSection />
    </div>
  );
}

/** One image slot (avatar or header): preview, upload with conversion, remove. */
function ImageSlot({ kind, profile }: { kind: "avatar" | "header"; profile: Profile }) {
  const t = useT();
  const queryClient = useQueryClient();
  const setUser = useAuth((s) => s.setUser);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const still = api.mediaUrl(kind === "avatar" ? profile.avatar_still : profile.header_still);
  const full = api.mediaUrl(kind === "avatar" ? profile.avatar : profile.header);
  const animated = full && full !== still ? full : null;
  const done = async (p: Profile) => {
    queryClient.setQueryData(["profile", "me", p.address], p);
    await queryClient.invalidateQueries({ queryKey: ["profile"] });
    const me = useAuth.getState().user;
    if (me && kind === "avatar") setUser({ ...me, avatar: p.avatar, avatar_still: p.avatar_still, avatar_blob_id: p.avatar_blob_id });
  };
  const upload = async (file: File) => {
    setError(null);
    if (file.size > UPLOAD_MAX_BYTES) {
      setError(t("profile.too_large"));
      return;
    }
    setBusy(true);
    try {
      await done(kind === "avatar" ? await api.profile.uploadAvatar(file) : await api.profile.uploadHeader(file));
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await done(kind === "avatar" ? await api.profile.deleteAvatar() : await api.profile.deleteHeader());
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2" data-testid={`${kind}-slot`}>
      <p className="text-sm text-fg-1">{t(`profile.${kind}`)}</p>
      {kind === "avatar" ? (
        <MediaAvatar name={profile.display_name} still={still} animated={animated} size={96} testId="avatar-preview" />
      ) : (
        <HeaderPreview still={still} animated={animated} />
      )}
      <p className="text-xs text-fg-2">{t(`profile.${kind}_hint`)}</p>
      <div className="flex flex-wrap gap-2">
        <input ref={input} type="file" accept={ACCEPT} className="sr-only" aria-label={t(`profile.${kind}_upload`)} data-testid={`${kind}-input`} onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
        <Button variant="ghost" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? t("profile.uploading") : t("profile.upload")}
        </Button>
        {still && (
          <Button variant="ghost" disabled={busy} onClick={() => void remove()} data-testid={`${kind}-remove`}>
            {t("profile.remove")}
          </Button>
        )}
      </div>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

function HeaderPreview({ still, animated }: { still: string | null; animated: string | null }) {
  const [hover, setHover] = useState(false);
  const src = animated && hover ? animated : still;
  return (
    <div className="aspect-[3/1] w-full max-w-md overflow-hidden rounded-md border border-line bg-bg-3" onPointerEnter={(e) => e.pointerType !== "touch" && setHover(true)} onPointerLeave={() => setHover(false)} data-testid="header-preview" data-animated={src && src === animated ? "true" : "false"}>
      {src && <img src={src} alt="" className="h-full w-full object-cover" />}
    </div>
  );
}

function ImagesSection({ profile }: { profile: Profile }) {
  const t = useT();
  return (
    <Section title={t("profile.images")} description={t("profile.images_hint")}>
      <div className="grid gap-6 md:grid-cols-[auto_1fr]">
        <ImageSlot kind="avatar" profile={profile} />
        <ImageSlot kind="header" profile={profile} />
      </div>
    </Section>
  );
}

/** Display name, bio and linked accounts: one form, one save. */
function AboutSection({ profile }: { profile: Profile }) {
  const t = useT();
  const queryClient = useQueryClient();
  const user = useAuth((s) => s.user);
  const setUser = useAuth((s) => s.setUser);
  const [displayName, setDisplayName] = useState(user?.display_name ?? "");
  const [bio, setBio] = useState(profile.bio);
  const [links, setLinks] = useState<ProfileLinkInput[]>(profile.links.map((l) => ({ service: l.service, value: l.value })));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setBio(profile.bio);
    setLinks(profile.links.map((l) => ({ service: l.service, value: l.value })));
  }, [profile.bio, profile.links]);
  const preview = useMemo(() => (bio.trim() ? renderMarkdown(bio) : ""), [bio]);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      setUser(await api.users.updateMe({ display_name: displayName, bio, links: links.filter((l) => l.value.trim()) }));
      await queryClient.invalidateQueries({ queryKey: ["profile"] });
      useToasts.getState().push({ kind: "info", title: t("user.profile_saved") });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  const setLink = (i: number, patch: Partial<ProfileLinkInput>) => setLinks((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Section title={t("user.profile")}>
        <Field label={t("user.address")} hint={t("user.address_hint")}>
          <Input value={user?.address ?? ""} readOnly disabled aria-readonly="true" data-testid="address-field" />
        </Field>
        <Field label={t("user.display_name")}>
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={64} required />
        </Field>
        <Field label={t("profile.bio")} hint={`${t("profile.bio_hint")} ${t("profile.bio_count", { count: bio.length, max: BIO_MAX })}`}>
          <Textarea name="bio" value={bio} onChange={(e) => setBio(e.target.value)} rows={4} maxLength={BIO_MAX} />
        </Field>
        {preview && <div className="markdown rounded-md border border-line bg-bg-0 p-3 text-sm text-fg-1" data-testid="bio-preview" dangerouslySetInnerHTML={{ __html: preview }} />}
        <div className="space-y-2">
          <p className="text-sm text-fg-1">{t("profile.links")}</p>
          <p className="text-xs text-fg-2">{t("profile.links_hint")}</p>
          <ul className="space-y-2" data-testid="links-editor">
            {links.map((l, i) => (
              <li key={i} className="flex flex-col gap-2 sm:flex-row">
                <Select aria-label={t("profile.link_service")} value={l.service} onChange={(e) => setLink(i, { service: e.target.value })} className="sm:w-40" name={`link_service_${i}`}>
                  {LINK_SERVICES.map((s) => (
                    <option key={s} value={s}>
                      {t(`profile.service.${s}`)}
                    </option>
                  ))}
                </Select>
                <Input aria-label={t("profile.link_value")} placeholder={t(`profile.placeholder.${l.service}`)} value={l.value} onChange={(e) => setLink(i, { value: e.target.value })} maxLength={256} name={`link_value_${i}`} />
                <Button variant="ghost" aria-label={t("profile.link_remove")} onClick={() => setLinks((ls) => ls.filter((_, j) => j !== i))}>
                  ×
                </Button>
              </li>
            ))}
          </ul>
          {links.length < LINKS_MAX && (
            <Button variant="ghost" onClick={() => setLinks((ls) => [...ls, { service: "steam", value: "" }])} data-testid="link-add">
              + {t("profile.link_add")}
            </Button>
          )}
        </div>
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end">
          <Button type="submit" disabled={busy} data-testid="about-save">
            {t("common.save")}
          </Button>
        </div>
      </Section>
    </form>
  );
}
