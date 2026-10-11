// SPDX-License-Identifier: Apache-2.0
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { usePrivacy } from "../stores/privacy";
import { renderWithProviders } from "../test/render";
import { GifView } from "./GifView";

const gif = { url: "https://media.giphy.com/media/abc/giphy.gif", width: 200, height: 100 };

describe("GIFs in messages follow the image preview setting", () => {
  beforeEach(() => usePrivacy.setState({ autoPreview: "friends_and_shared", maxBytes: 5 * 1024 * 1024, friends: new Set() }));

  it("never: a placeholder, nothing loads before the click, then without a referrer", async () => {
    usePrivacy.setState({ autoPreview: "never" });
    const clicked = { ...gif, url: "https://media.tenor.com/x/clicked.gif" };
    renderWithProviders(<GifView gif={clicked} author="eve@far.test" own={false} inRoom />);
    expect(screen.queryByTestId("gif")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "GIF laden" }));
    const img = screen.getByTestId("gif");
    expect(img).toHaveAttribute("src", clicked.url);
    expect(img).toHaveAttribute("referrerpolicy", "no-referrer");
  });

  it("friends and shared rooms: a stranger's GIF in a message request waits, a room member's loads", () => {
    const { unmount } = renderWithProviders(<GifView gif={gif} author="eve@far.test" own={false} inRoom={false} />);
    expect(screen.queryByTestId("gif")).toBeNull();
    expect(screen.getByTestId("gif-placeholder")).toBeInTheDocument();
    unmount();
    renderWithProviders(<GifView gif={gif} author="bob@a.test" own={false} inRoom />);
    expect(screen.getByTestId("gif")).toHaveAttribute("referrerpolicy", "no-referrer");
  });

  it("always: loads at once", () => {
    usePrivacy.setState({ autoPreview: "always" });
    renderWithProviders(<GifView gif={gif} author="eve@far.test" own={false} inRoom={false} />);
    expect(screen.getByTestId("gif")).toBeInTheDocument();
  });
});
