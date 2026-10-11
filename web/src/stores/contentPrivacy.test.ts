// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONTENT_PRIVACY, parseContentPrivacy, useContentPrivacy } from "./contentPrivacy";

describe("content privacy settings", () => {
  beforeEach(() => {
    localStorage.clear();
    useContentPrivacy.setState(DEFAULT_CONTENT_PRIVACY);
  });

  it("defaults: strip always, thumbnails, create and show previews, none while typing in encrypted conversations", () => {
    expect(parseContentPrivacy(null)).toEqual({ metadata: "always", embeds: "thumbnail", createPreviews: true, encryptedPreviews: false, showPreviews: true });
  });

  it("ignores invalid stored values field by field", () => {
    expect(parseContentPrivacy({ metadata: "sometimes", embeds: "off", createPreviews: "yes", encryptedPreviews: "yes", showPreviews: false })).toEqual({ metadata: "always", embeds: "off", createPreviews: true, encryptedPreviews: false, showPreviews: false });
    expect(parseContentPrivacy({ encryptedPreviews: true }).encryptedPreviews).toBe(true);
  });

  it("saves changes locally", () => {
    useContentPrivacy.getState().set({ metadata: "ask", createPreviews: false });
    expect(useContentPrivacy.getState()).toMatchObject({ metadata: "ask", createPreviews: false, embeds: "thumbnail" });
    expect(JSON.parse(localStorage.getItem("tavrn.privacy.content")!)).toEqual({ metadata: "ask", embeds: "thumbnail", createPreviews: false, encryptedPreviews: false, showPreviews: true });
  });
});
