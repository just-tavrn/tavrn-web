// SPDX-License-Identifier: Apache-2.0
/**
 * Privacy settings the message views need at once (design note 4.12): the `auto_preview` setting (kept on the
 * home node via `PATCH /users/me`, mirrored in local storage so the first render after a reload already
 * uses it), the node's automatic preview cap and the addresses of the user's friends. The decision itself
 * is the pure `shouldAutoPreview` in `lib/preview.ts`.
 */
import { create } from "zustand";
import { DEFAULT_AUTO_PREVIEW, DEFAULT_PREVIEW_MAX_BYTES, isAutoPreview, type AutoPreview } from "../lib/preview";

const KEY = "tavrn.privacy.auto_preview";

function readLocal(): AutoPreview {
  try {
    const v = localStorage.getItem(KEY);
    return isAutoPreview(v) ? v : DEFAULT_AUTO_PREVIEW;
  } catch {
    return DEFAULT_AUTO_PREVIEW;
  }
}

function writeLocal(v: AutoPreview) {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    /* storage disabled: memory only */
  }
}

interface PrivacyState {
  autoPreview: AutoPreview;
  /** The node's `preview_auto_max_bytes`. */
  maxBytes: number;
  /** Addresses of the user's friends. */
  friends: ReadonlySet<string>;
  /** Takes a value served by the node (ignored unless valid). */
  hydrate: (value: unknown) => void;
  /** Changes the setting locally at once and on the node; reverts if the node refuses. */
  save: (value: AutoPreview, put: (value: AutoPreview) => Promise<unknown>) => Promise<void>;
  setMaxBytes: (bytes: unknown) => void;
  setFriends: (addresses: string[]) => void;
}

export const usePrivacy = create<PrivacyState>((set, get) => ({
  autoPreview: readLocal(),
  maxBytes: DEFAULT_PREVIEW_MAX_BYTES,
  friends: new Set(),
  hydrate: (value) => {
    if (!isAutoPreview(value)) return;
    writeLocal(value);
    set({ autoPreview: value });
  },
  save: async (value, put) => {
    const previous = get().autoPreview;
    writeLocal(value);
    set({ autoPreview: value });
    try {
      await put(value);
    } catch (e) {
      writeLocal(previous);
      set({ autoPreview: previous });
      throw e;
    }
  },
  setMaxBytes: (bytes) => {
    if (typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0) set({ maxBytes: bytes });
  },
  setFriends: (addresses) => {
    const current = get().friends;
    if (addresses.length === current.size && addresses.every((a) => current.has(a))) return;
    set({ friends: new Set(addresses) });
  },
}));
