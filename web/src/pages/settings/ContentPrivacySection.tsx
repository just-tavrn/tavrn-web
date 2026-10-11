// SPDX-License-Identifier: Apache-2.0
/**
 * Device-local content privacy (design note 4.13 items 6 and 7): image metadata removal before upload, embeds
 * and link previews. Stored on this device only (`stores/contentPrivacy.ts`).
 */
import { useT } from "../../i18n";
import { EMBED_MODES, METADATA_MODES, useContentPrivacy } from "../../stores/contentPrivacy";
import { Section } from "./common";

export function ContentPrivacySection() {
  const t = useT();
  const s = useContentPrivacy();
  return (
    <>
      <Section title={t("privacy.metadata_title")} description={t("privacy.metadata_hint")}>
        <div role="radiogroup" aria-label={t("privacy.metadata_title")} className="space-y-1" data-testid="metadata-mode">
          {METADATA_MODES.map((v) => (
            <label key={v} className="flex min-h-10 items-center gap-2 text-sm">
              <input type="radio" name="metadata_mode" value={v} className="h-4 w-4 accent-accent" checked={s.metadata === v} onChange={() => s.set({ metadata: v })} />
              {t(`privacy.metadata.${v}`)}
            </label>
          ))}
        </div>
      </Section>
      <Section title={t("privacy.embeds_title")} description={t("privacy.embeds_hint")}>
        <div role="radiogroup" aria-label={t("privacy.embeds_title")} className="space-y-1" data-testid="embed-mode">
          {EMBED_MODES.map((v) => (
            <label key={v} className="flex min-h-10 items-center gap-2 text-sm">
              <input type="radio" name="embed_mode" value={v} className="h-4 w-4 accent-accent" checked={s.embeds === v} onChange={() => s.set({ embeds: v })} />
              {t(`privacy.embeds.${v}`)}
            </label>
          ))}
        </div>
      </Section>
      <Section title={t("privacy.link_previews_title")}>
        <label className="flex min-h-10 items-center gap-2 text-sm">
          <input type="checkbox" className="h-4 w-4 accent-accent" checked={s.createPreviews} onChange={(e) => s.set({ createPreviews: e.target.checked })} data-testid="create-previews" />
          {t("privacy.create_previews")}
        </label>
        <p className="text-xs text-fg-2">{t("privacy.create_previews_hint")}</p>
        <label className="flex min-h-10 items-center gap-2 text-sm">
          <input type="checkbox" className="h-4 w-4 accent-accent" checked={s.encryptedPreviews} disabled={!s.createPreviews} onChange={(e) => s.set({ encryptedPreviews: e.target.checked })} data-testid="encrypted-previews" aria-describedby="encrypted-previews-hint" />
          {t("privacy.encrypted_previews")}
        </label>
        <p id="encrypted-previews-hint" className="text-xs text-fg-2">{t("privacy.encrypted_previews_hint")}</p>
        <label className="flex min-h-10 items-center gap-2 text-sm">
          <input type="checkbox" className="h-4 w-4 accent-accent" checked={s.showPreviews} onChange={(e) => s.set({ showPreviews: e.target.checked })} data-testid="show-previews" />
          {t("privacy.show_previews")}
        </label>
        <p className="text-xs text-fg-2">{t("privacy.show_previews_hint")}</p>
      </Section>
    </>
  );
}
