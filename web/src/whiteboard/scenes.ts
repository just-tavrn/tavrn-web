// SPDX-License-Identifier: Apache-2.0
/**
 * The personal scene library (tavrn-protocol/WHITEBOARD.md §5): scenes are serialized to JSON and encrypted on
 * this device under the backup key (`encryptScene`, bound to the scene id and the part), so the home node
 * stores only ciphertext, the plaintext name, sizes and dates.
 */
import { decryptScene, encryptScene } from "@tavrn/crypto";
import type { SceneInfo, TavrnApi } from "@tavrn/sdk";
import { ensureCrypto } from "@tavrn/e2ee";
import { sanitizeColor, sanitizeElements, sanitizeFiles } from "./sync";
import type { Scene } from "./controller";

export const SCENE_FORMAT = 1;
/** The node's limit for an encrypted scene. */
export const MAX_SCENE_BYTES = 5 * 1024 * 1024;
/** The node's limit for an encrypted thumbnail. */
export const MAX_THUMBNAIL_BYTES = 64 * 1024;
const GCM_OVERHEAD = 1 + 12 + 16;

export class SceneError extends Error {
  constructor(readonly code: "too_large" | "locked" | "invalid" | "not_found") {
    super(code);
    this.name = "SceneError";
  }
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A new ULID (time-ordered, 80 random bits): scene ids are chosen by the client. */
export function newSceneId(now = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  const random = crypto.getRandomValues(new Uint8Array(16));
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD[random[i]! % 32];
  return time + rand;
}

export function serializeScene(scene: Scene): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ v: SCENE_FORMAT, elements: scene.elements, files: scene.files, background: scene.background }));
}

/** Parses a decrypted scene; untrusted content is validated like network payloads. */
export function parseScene(bytes: Uint8Array): Scene {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new SceneError("invalid");
  }
  if (!raw || typeof raw !== "object" || (raw as { v?: unknown }).v !== SCENE_FORMAT) throw new SceneError("invalid");
  const r = raw as Record<string, unknown>;
  return { elements: sanitizeElements(r.elements), files: sanitizeFiles(r.files), background: sanitizeColor(r.background) ?? "#ffffff" };
}

/** Encrypts a scene for the library (`key`: the backup key). */
export function sealScene(key: Uint8Array, sceneId: string, scene: Scene): Uint8Array {
  const plain = serializeScene(scene);
  if (plain.length + GCM_OVERHEAD > MAX_SCENE_BYTES) throw new SceneError("too_large");
  return encryptScene(key, sceneId, "scene", plain);
}

export function openScene(key: Uint8Array, sceneId: string, blob: Uint8Array): Scene {
  let plain: Uint8Array;
  try {
    plain = decryptScene(key, sceneId, "scene", blob);
  } catch {
    throw new SceneError("invalid");
  }
  return parseScene(plain);
}

export function sealThumbnail(key: Uint8Array, sceneId: string, image: Uint8Array): Uint8Array | null {
  if (image.length + GCM_OVERHEAD > MAX_THUMBNAIL_BYTES) return null;
  return encryptScene(key, sceneId, "thumbnail", image);
}

export function openThumbnail(key: Uint8Array, sceneId: string, blob: Uint8Array): Uint8Array | null {
  try {
    return decryptScene(key, sceneId, "thumbnail", blob);
  } catch {
    return null;
  }
}

/** Bytes of a `data:` URL (thumbnails). */
export function dataUrlBytes(url: string): Uint8Array | null {
  const comma = url.indexOf(",");
  if (!url.startsWith("data:") || comma < 0 || !url.slice(0, comma).endsWith(";base64")) return null;
  try {
    const bin = atob(url.slice(comma + 1));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Runs `fn` with the backup key; `null` from the provider means the device is locked. */
export type WithKey = <T>(fn: (key: Uint8Array) => T) => T | null;

/** The library on the home node: the user's scenes, encrypted on this device. */
export function sceneLibrary(api: TavrnApi, withKey: WithKey) {
  const key = <T>(fn: (k: Uint8Array) => T): T => {
    const out = withKey(fn);
    if (out === null) throw new SceneError("locked");
    return out;
  };
  return {
    list: () => api.whiteboards.list(),
    /** Saves `scene` under `sceneId` (new: with `name`); the thumbnail (a data URL) is optional. */
    async save(sceneId: string, scene: Scene, opts: { name?: string; thumbnail?: string | null } = {}): Promise<SceneInfo> {
      await ensureCrypto();
      const blob = key((k) => sealScene(k, sceneId, scene));
      const info = await api.whiteboards.put(sceneId, blob, opts.name);
      const image = opts.thumbnail ? dataUrlBytes(opts.thumbnail) : null;
      const thumb = image ? key((k) => sealThumbnail(k, sceneId, image)) : null;
      if (thumb) await api.whiteboards.putThumbnail(sceneId, thumb).catch(() => undefined);
      return info;
    },
    async load(sceneId: string): Promise<Scene> {
      await ensureCrypto();
      const blob = await api.whiteboards.get(sceneId);
      if (!blob) throw new SceneError("not_found");
      return key((k) => openScene(k, sceneId, blob));
    },
    /** An object URL of the decrypted thumbnail, or null (revoke it when done). */
    async thumbnailUrl(sceneId: string): Promise<string | null> {
      await ensureCrypto();
      const blob = await api.whiteboards.thumbnail(sceneId);
      const image = blob ? withKey((k) => openThumbnail(k, sceneId, blob)) : null;
      return image ? URL.createObjectURL(new Blob([image as Uint8Array<ArrayBuffer>], { type: "image/webp" })) : null;
    },
    rename: (sceneId: string, name: string) => api.whiteboards.rename(sceneId, name),
    remove: (sceneId: string) => api.whiteboards.delete(sceneId),
  };
}

export type SceneLibrary = ReturnType<typeof sceneLibrary>;
