// SPDX-License-Identifier: Apache-2.0
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONTENT_PRIVACY, useContentPrivacy } from "../stores/contentPrivacy";
import { mockFetch } from "../test/render";
import { UNFURL_DEBOUNCE_MS, useComposePreview } from "./ComposePreview";

const TEXT = "look https://news.example/article";

async function unfurlRequests(encrypted: boolean): Promise<number> {
  const calls = mockFetch({
    "/node": { body: { capabilities: ["unfurl"] } },
    "/unfurl": { body: { url: "https://news.example/article", title: "Article", description: null, site_name: null, image: null } },
  });
  const { unmount } = renderHook(() => useComposePreview(TEXT, true, encrypted));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(UNFURL_DEBOUNCE_MS + 50);
  });
  unmount();
  return calls.filter((c) => c.url.includes("/unfurl")).length;
}

describe("link previews while typing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useContentPrivacy.setState(DEFAULT_CONTENT_PRIVACY);
  });
  afterEach(() => vi.useRealTimers());

  it("plaintext conversations: the home node unfurls the link (default)", async () => {
    expect(await unfurlRequests(false)).toBe(1);
  });

  it("encrypted conversations: the link never reaches the node unless the user turned it on", async () => {
    expect(await unfurlRequests(true)).toBe(0);
    useContentPrivacy.getState().set({ encryptedPreviews: true });
    expect(await unfurlRequests(true)).toBe(1);
  });

  it("the general switch still turns previews off everywhere", async () => {
    useContentPrivacy.getState().set({ createPreviews: false, encryptedPreviews: true });
    expect(await unfurlRequests(true)).toBe(0);
    expect(await unfurlRequests(false)).toBe(0);
  });
});
