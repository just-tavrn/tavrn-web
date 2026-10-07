// SPDX-License-Identifier: Apache-2.0
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { LinkPreviews } from "./LinkPreviews";
import { DEFAULT_CONTENT_PRIVACY, useContentPrivacy } from "../stores/contentPrivacy";

const YT = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const preview = { url: "https://news.example/a", title: "Headline", description: "Teaser", site: "News", image: "data:image/webp;base64,UklGRg==" };

describe("LinkPreviews", () => {
  beforeEach(() => act(() => useContentPrivacy.setState(DEFAULT_CONTENT_PRIVACY)));

  it("shows a click-to-play embed with a thumbnail; the player loads only after the click", () => {
    render(<LinkPreviews body={`look ${YT}`} content={{}} />);
    const card = screen.getByTestId("embed-card");
    expect(card.dataset.provider).toBe("youtube");
    expect(screen.getByTestId("embed-thumbnail").getAttribute("src")).toBe("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
    expect(screen.getByTestId("embed-thumbnail").getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(screen.queryByTestId("embed-frame")).toBeNull();
    fireEvent.click(screen.getByTestId("embed-play"));
    const frame = screen.getByTestId("embed-frame");
    expect(frame.getAttribute("src")).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin allow-presentation allow-popups");
  });

  it("follows the embed setting", () => {
    act(() => useContentPrivacy.setState({ embeds: "click" }));
    const { rerender } = render(<LinkPreviews body={YT} content={{}} />);
    expect(screen.getByTestId("embed-play")).toBeTruthy();
    expect(screen.queryByTestId("embed-thumbnail")).toBeNull();
    act(() => useContentPrivacy.setState({ embeds: "off" }));
    rerender(<LinkPreviews body={`${YT} `} content={{}} />);
    expect(screen.queryByTestId("embed-card")).toBeNull();
  });

  it("renders the sender's preview only for a link in the text, as a safe link", () => {
    const { rerender } = render(<LinkPreviews body="read https://news.example/a" content={{ preview }} />);
    const title = screen.getByTestId("link-preview-title");
    expect(title.textContent).toBe("Headline");
    expect(title.getAttribute("href")).toBe("https://news.example/a");
    expect(title.getAttribute("rel")).toContain("noopener");
    expect(screen.getByTestId("link-preview-image").getAttribute("src")).toBe(preview.image);
    rerender(<LinkPreviews body="read https://other.example" content={{ preview }} />);
    expect(screen.queryByTestId("link-preview")).toBeNull();
    act(() => useContentPrivacy.setState({ showPreviews: false }));
    rerender(<LinkPreviews body="read https://news.example/a" content={{ preview }} />);
    expect(screen.queryByTestId("link-preview")).toBeNull();
  });

  it("renders nothing for text without links", () => {
    const { container } = render(<LinkPreviews body="hello" content={{ preview }} />);
    expect(container.innerHTML).toBe("");
  });
});
