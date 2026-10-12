// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { clipboardFileName, isGenericClipboardName, renameClipboardFiles } from "./clipboardName";

const at = new Date(2026, 9, 12, 17, 2);

describe("clipboard file names", () => {
  it("recognises the names browsers and systems make up", () => {
    for (const n of ["image.png", "image.jpeg", "Image.PNG", "image-1.png", "unknown.png", "blob.png", "{A950873F-99E1-4025-87B9-C69CD78EE10C}.png", "a950873f-99e1-4025-87b9-c69cd78ee10c.jpg", ""]) {
      expect(isGenericClipboardName(n), n).toBe(true);
    }
    for (const n of ["holiday.png", "image of a cat.png", "report.pdf", "IMG_2041.jpg", "{not-a-guid}.png"]) {
      expect(isGenericClipboardName(n), n).toBe(false);
    }
  });

  it("names a pasted screenshot by word, local date and time with the extension of its type", () => {
    expect(clipboardFileName({ name: "{A950873F-99E1-4025-87B9-C69CD78EE10C}.png", type: "image/png" }, "Screenshot", at)).toBe("Screenshot 2026-10-12 17-02.png");
    expect(clipboardFileName({ name: "image.png", type: "image/jpeg" }, "Bild", at)).toBe("Bild 2026-10-12 17-02.jpg");
    expect(clipboardFileName({ name: "", type: "image/webp" }, "Image", at)).toBe("Image 2026-10-12 17-02.webp");
    // Unknown type: the original extension, else bin.
    expect(clipboardFileName({ name: "image.heic", type: "" }, "Image", at)).toBe("Image 2026-10-12 17-02.heic");
    expect(clipboardFileName({ name: "", type: "" }, "Image", at)).toBe("Image 2026-10-12 17-02.bin");
  });

  it("keeps real file names", () => {
    expect(clipboardFileName({ name: "holiday.png", type: "image/png" }, "Image", at)).toBe("holiday.png");
  });

  it("renames only the generic files and keeps the bytes and type", async () => {
    const real = new File([new Uint8Array([1, 2])], "holiday.png", { type: "image/png" });
    const pasted = new File([new Uint8Array([3, 4, 5])], "image.png", { type: "image/png", lastModified: 5 });
    const [a, b] = renameClipboardFiles([real, pasted], "Image", at) as [File, File];
    expect(a).toBe(real);
    expect(b.name).toBe("Image 2026-10-12 17-02.png");
    expect(b.type).toBe("image/png");
    expect(b.lastModified).toBe(5);
    expect(new Uint8Array(await b.arrayBuffer())).toEqual(new Uint8Array([3, 4, 5]));
  });
});
