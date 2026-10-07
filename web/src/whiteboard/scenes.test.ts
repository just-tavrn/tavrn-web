// SPDX-License-Identifier: Apache-2.0
// @vitest-environment node
// Scene serialization and the encryption round trip with the real WebAssembly crypto.
import { beforeAll, describe, expect, it } from "vitest";
import { MasterSecret } from "@tavrn/crypto";
import type { SceneInfo, TavrnApi } from "@tavrn/sdk";
import { initCryptoForTests } from "../test/wasm";
import { MAX_SCENE_BYTES, SceneError, dataUrlBytes, newSceneId, openScene, openThumbnail, parseScene, sceneLibrary, sealScene, sealThumbnail, serializeScene } from "./scenes";
import type { Scene } from "./controller";

beforeAll(() => initCryptoForTests());

const scene: Scene = {
  elements: [
    { id: "r", type: "rectangle", version: 3, versionNonce: 9, index: "a0", x: 1, y: 2, width: 30, height: 40, strokeColor: "#1e1e1e" },
    { id: "t", type: "text", version: 1, versionNonce: 2, index: "a1", text: "Raid um 20 Uhr ✓" },
  ],
  files: [{ id: "f", mimeType: "image/png", dataURL: "data:image/png;base64,iVBORw0KGgo=", created: 5 }],
  background: "#fdf6e3",
};

describe("scene library format", () => {
  it("creates time-ordered ULIDs", () => {
    const a = newSceneId(1_700_000_000_000);
    const b = newSceneId(1_700_000_000_001);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
    expect(newSceneId()).not.toBe(newSceneId());
  });

  it("round-trips a scene through the backup-key encryption", () => {
    const master = MasterSecret.generate();
    const key = master.backupKey();
    const id = newSceneId();
    const blob = sealScene(key, id, scene);
    expect(blob[0]).toBe(1);
    expect(new TextDecoder().decode(blob)).not.toContain("Raid");
    expect(openScene(key, id, blob)).toEqual(scene);
    // Bound to the key and the scene id; the thumbnail role cannot be confused with the scene.
    expect(() => openScene(MasterSecret.generate().backupKey(), id, blob)).toThrow(SceneError);
    expect(() => openScene(key, newSceneId(), blob)).toThrow(SceneError);
    const thumb = sealThumbnail(key, id, new Uint8Array([1, 2, 3]))!;
    expect(Array.from(openThumbnail(key, id, thumb)!)).toEqual([1, 2, 3]);
    expect(() => openScene(key, id, thumb)).toThrow(SceneError);
    expect(sealThumbnail(key, id, new Uint8Array(70_000))).toBeNull();
    master.free();
  });

  it("validates decrypted scenes like network payloads and refuses oversized ones", () => {
    const bytes = serializeScene({ ...scene, elements: [...scene.elements, { id: "x", type: "evil", version: 1, versionNonce: 1 }], background: "url(x)" });
    const parsed = parseScene(bytes);
    expect(parsed.elements.map((e) => e.id)).toEqual(["r", "t"]);
    expect(parsed.background).toBe("#ffffff");
    expect(() => parseScene(new TextEncoder().encode('{"v":2}'))).toThrow(SceneError);
    expect(() => parseScene(new Uint8Array([0xff, 0xfe]))).toThrow(SceneError);
    const key = MasterSecret.generate().backupKey();
    const huge: Scene = { ...scene, files: [{ id: "big", mimeType: "image/png", dataURL: `data:image/png;base64,${"A".repeat(MAX_SCENE_BYTES)}`, created: 1 }] };
    expect(() => sealScene(key, newSceneId(), huge)).toThrow(SceneError);
  });

  it("decodes data URLs", () => {
    expect(Array.from(dataUrlBytes("data:image/webp;base64,AQID")!)).toEqual([1, 2, 3]);
    expect(dataUrlBytes("data:image/webp,plain")).toBeNull();
    expect(dataUrlBytes("https://x")).toBeNull();
  });

  it("saves and loads through the API with the key of this device", async () => {
    const master = MasterSecret.generate();
    const stored = new Map<string, { blob: Uint8Array; name?: string; thumb?: Uint8Array }>();
    const api = {
      whiteboards: {
        list: async () => ({ items: [], max_scenes: 50, max_scene_bytes: MAX_SCENE_BYTES }),
        put: async (id: string, blob: Uint8Array, name?: string) => {
          stored.set(id, { ...stored.get(id), blob, name: name ?? stored.get(id)?.name });
          return { id, name: name ?? "", size: blob.length, thumbnail_size: 0, created_at: "", updated_at: "" } satisfies SceneInfo;
        },
        get: async (id: string) => stored.get(id)?.blob ?? null,
        putThumbnail: async (id: string, blob: Uint8Array) => void (stored.get(id)!.thumb = blob),
        thumbnail: async (id: string) => stored.get(id)?.thumb ?? null,
        rename: async () => ({}),
        delete: async () => undefined,
      },
    } as unknown as TavrnApi;
    let locked = false;
    const lib = sceneLibrary(api, (fn) => {
      if (locked) return null;
      const k = master.backupKey();
      try {
        return fn(k);
      } finally {
        k.fill(0);
      }
    });
    const id = newSceneId();
    await lib.save(id, scene, { name: "Plan", thumbnail: "data:image/webp;base64,AQID" });
    expect(stored.get(id)!.name).toBe("Plan");
    expect(stored.get(id)!.thumb![0]).toBe(1);
    expect(await lib.load(id)).toEqual(scene);
    await expect(lib.load(newSceneId())).rejects.toMatchObject({ code: "not_found" });
    locked = true;
    await expect(lib.load(id)).rejects.toMatchObject({ code: "locked" });
  });
});
