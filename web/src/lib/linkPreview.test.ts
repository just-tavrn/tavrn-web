// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { MAX_CONTENT_BYTES, cardsOf, extractUrls, fitPreview, fromUnfurl, readPreview, unfurlCandidate } from "./linkPreview";

const P = "chat.example";
const IMG = "data:image/webp;base64,UklGRg==";

describe("extractUrls", () => {
  it("finds http(s) links without trailing punctuation, duplicates or code", () => {
    expect(extractUrls("see https://a.example/x, and (https://b.example/y). Also https://a.example/x!")).toEqual(["https://a.example/x", "https://b.example/y"]);
    expect(extractUrls("wiki https://en.wikipedia.org/wiki/Foo_(bar) ok")).toEqual(["https://en.wikipedia.org/wiki/Foo_(bar)"]);
    expect(extractUrls("`https://code.example` ```\nhttps://block.example\n``` <https://c.example>")).toEqual(["https://c.example"]);
    expect(extractUrls("javascript:alert(1) ftp://x.example mailto:a@b")).toEqual([]);
    expect(extractUrls(Array.from({ length: 30 }, (_, i) => `https://e${i}.example`).join(" "))).toHaveLength(20);
    // Pathological input stays fast (linear trimming).
    const started = performance.now();
    expect(extractUrls(`https://a.example/${")".repeat(50_000)}`)).toEqual(["https://a.example/"]);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("picks the first non-embed link to unfurl", () => {
    expect(unfurlCandidate("https://youtu.be/dQw4w9WgXcQ https://news.example/a", P)).toBe("https://news.example/a");
    expect(unfurlCandidate("only https://youtu.be/dQw4w9WgXcQ", P)).toBeNull();
    expect(unfurlCandidate("no links", P)).toBeNull();
  });
});

describe("readPreview", () => {
  const ok = { url: "https://news.example/a", title: "Title", description: "Desc", site: "News", image: IMG };
  it("accepts a well-formed preview whose link is in the text", () => {
    expect(readPreview(ok, "read https://news.example/a")).toEqual(ok);
  });
  it("refuses previews for links the text does not show (no hidden targets)", () => {
    expect(readPreview(ok, "read https://other.example")).toBeNull();
    expect(readPreview({ ...ok, url: "javascript:alert(1)" }, "javascript:alert(1)")).toBeNull();
  });
  it("drops unsafe images and cleans texts", () => {
    const body = "https://news.example/a";
    expect(readPreview({ ...ok, image: "https://tracker.example/p.gif" }, body)!.image).toBeUndefined();
    expect(readPreview({ ...ok, image: "data:image/svg+xml;base64,PHN2Zz4=" }, body)!.image).toBeUndefined();
    expect(readPreview({ ...ok, image: `${IMG}"><script>` }, body)!.image).toBeUndefined();
    expect(readPreview({ ...ok, title: "a‮b\u0007", site: "" }, body)).toMatchObject({ title: "ab", site: "news.example" });
    expect(readPreview({ ...ok, title: "x".repeat(400) }, body)!.title).toHaveLength(300);
    expect(readPreview({ url: ok.url, title: "", description: "" }, body)).toBeNull();
    expect(readPreview("nope", body)).toBeNull();
    expect(readPreview({ ...ok, title: 5, description: "d" }, body)).toMatchObject({ title: "", description: "d" });
  });
});

describe("fitPreview and fromUnfurl", () => {
  it("drops the image when the content would exceed the node's limit", () => {
    const big = `data:image/webp;base64,${"A".repeat(40 * 1024 * 4 / 3)}`;
    const preview = { url: "https://n.example", title: "T", description: "", site: "n", image: big };
    const short = { type: "text", body: "https://n.example" };
    expect(fitPreview(short, preview, false).image).toBe(big);
    // Encrypted: the ciphertext is base64 again, so a full 40 KiB image does not fit, a typical one does.
    expect(fitPreview(short, preview, true).image).toBeUndefined();
    const typical = { ...preview, image: `data:image/webp;base64,${"A".repeat(24 * 1024 * 4 / 3)}` };
    expect(fitPreview(short, typical, true).image).toBe(typical.image);
    const long = { type: "text", body: "ü".repeat(4000) };
    expect(fitPreview(long, preview, true).image).toBeUndefined();
    expect(JSON.stringify({ ...long, preview: fitPreview(long, preview, true) }).length).toBeLessThan(MAX_CONTENT_BYTES);
  });
  it("maps the node's answer", () => {
    expect(fromUnfurl({ url: "https://a", title: "T", description: "", site: "a", image_data_url: IMG })).toEqual({ url: "https://a", title: "T", description: "", site: "a", image: IMG });
    expect(fromUnfurl({ url: "https://a", title: "", description: "", site: "a" })).toBeNull();
  });
});

describe("cardsOf", () => {
  const preview = { url: "https://news.example/a", title: "T", description: "", site: "n" };
  it("shows up to three embeds and the preview", () => {
    const body = "https://youtu.be/dQw4w9WgXcQ https://youtu.be/dQw4w9WgXcQ https://vimeo.com/1 https://news.example/a";
    const c = cardsOf(body, preview, P, { embeds: true, previews: true });
    expect(c.embeds.map((e) => e.provider)).toEqual(["youtube", "vimeo"]);
    expect(c.preview).toEqual(preview);
    const many = "https://vimeo.com/1 https://vimeo.com/2 https://vimeo.com/3 https://vimeo.com/4 https://news.example/a";
    const m = cardsOf(many, preview, P, { embeds: true, previews: true });
    expect(m.embeds).toHaveLength(3);
    expect(m.preview).toBeNull();
  });
  it("follows the settings", () => {
    const body = "https://youtu.be/dQw4w9WgXcQ https://news.example/a";
    expect(cardsOf(body, preview, P, { embeds: false, previews: true })).toEqual({ embeds: [], preview });
    expect(cardsOf(body, preview, P, { embeds: true, previews: false }).preview).toBeNull();
  });
});
