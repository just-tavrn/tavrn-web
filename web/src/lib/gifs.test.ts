// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { isGifUrl } from "./gifs";

describe("isGifUrl", () => {
  it("accepts only https URLs of the known GIF providers", () => {
    expect(isGifUrl("https://media.giphy.com/media/x/giphy.gif")).toBe(true);
    expect(isGifUrl("https://media.tenor.com/abc.gif")).toBe(true);
    expect(isGifUrl("http://media.giphy.com/x.gif")).toBe(false);
    expect(isGifUrl("https://evil.example/x.gif")).toBe(false);
    expect(isGifUrl("https://media.giphy.com.evil.example/x.gif")).toBe(false);
    expect(isGifUrl("https://user@media.giphy.com/x.gif")).toBe(false);
    expect(isGifUrl("https://media.giphy.com:8443/x.gif")).toBe(false);
    expect(isGifUrl(42)).toBe(false);
  });
});
