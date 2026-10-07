// SPDX-License-Identifier: Apache-2.0
/**
 * Device-local content privacy settings (design note 4.13 items 6 and 7): removal of image metadata before
 * upload, embeds, creating link previews when sending and showing them. Kept in local storage only (they
 * decide what this device sends or loads); invalid stored values fall back to the defaults.
 */
import { create } from "zustand";

export type MetadataMode = "always" | "ask" | "never";
export type EmbedMode = "thumbnail" | "click" | "off";

export const METADATA_MODES: readonly MetadataMode[] = ["always", "ask", "never"];
export const EMBED_MODES: readonly EmbedMode[] = ["thumbnail", "click", "off"];

export interface ContentPrivacy {
  metadata: MetadataMode;
  embeds: EmbedMode;
  createPreviews: boolean;
  showPreviews: boolean;
}

export const DEFAULT_CONTENT_PRIVACY: ContentPrivacy = { metadata: "always", embeds: "thumbnail", createPreviews: true, showPreviews: true };

const KEY = "tavrn.privacy.content";

/** Stored settings, each field validated on its own. */
export function parseContentPrivacy(raw: unknown): ContentPrivacy {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    metadata: METADATA_MODES.includes(r.metadata as MetadataMode) ? (r.metadata as MetadataMode) : DEFAULT_CONTENT_PRIVACY.metadata,
    embeds: EMBED_MODES.includes(r.embeds as EmbedMode) ? (r.embeds as EmbedMode) : DEFAULT_CONTENT_PRIVACY.embeds,
    createPreviews: typeof r.createPreviews === "boolean" ? r.createPreviews : DEFAULT_CONTENT_PRIVACY.createPreviews,
    showPreviews: typeof r.showPreviews === "boolean" ? r.showPreviews : DEFAULT_CONTENT_PRIVACY.showPreviews,
  };
}

function readLocal(): ContentPrivacy {
  try {
    const raw = localStorage.getItem(KEY);
    return parseContentPrivacy(raw ? JSON.parse(raw) : null);
  } catch {
    return DEFAULT_CONTENT_PRIVACY;
  }
}

interface State extends ContentPrivacy {
  set: (patch: Partial<ContentPrivacy>) => void;
}

export const useContentPrivacy = create<State>((set, get) => ({
  ...readLocal(),
  set: (patch) => {
    const next = parseContentPrivacy({ ...pick(get()), ...patch });
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* storage disabled: memory only */
    }
    set(next);
  },
}));

function pick(s: ContentPrivacy): ContentPrivacy {
  return { metadata: s.metadata, embeds: s.embeds, createPreviews: s.createPreviews, showPreviews: s.showPreviews };
}
