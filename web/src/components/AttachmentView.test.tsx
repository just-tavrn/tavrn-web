// SPDX-License-Identifier: Apache-2.0
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { MessageAttachments, mediaKind, type ViewAttachment } from "./AttachmentView";
import { usePrivacy } from "../stores/privacy";
import { mockFetch } from "../test/render";

const image = (id: string, size = 1000, name = `${id}.png`): ViewAttachment => ({ id, name, mime: "image/png", size, encrypted: null });

describe("MessageAttachments: automatic previews (design note 4.12)", () => {
  beforeEach(() => {
    mockFetch({});
    usePrivacy.setState({ autoPreview: "friends_and_shared", maxBytes: 5000, friends: new Set(["friend@t.local"]) });
  });

  it("loads images of room members and friends, but not of strangers in DMs", () => {
    const { unmount } = render(<MessageAttachments items={[image("a")]} author="stranger@t.local" inRoom />);
    expect(screen.getByTestId("attachment-image")).toBeInTheDocument();
    unmount();
    const friend = render(<MessageAttachments items={[image("b")]} author="friend@t.local" />);
    expect(screen.getByTestId("attachment-image")).toBeInTheDocument();
    friend.unmount();
    render(<MessageAttachments items={[image("c")]} author="stranger@t.local" />);
    expect(screen.queryByTestId("attachment-image")).toBeNull();
    const placeholder = screen.getByTestId("preview-placeholder");
    expect(placeholder).toHaveTextContent("c.png");
    expect(placeholder).toHaveTextContent("1000 B");
    fireEvent.click(screen.getByTestId("preview-load"));
    expect(screen.getByTestId("attachment-image")).toBeInTheDocument();
  });

  it("never: placeholders even for own messages, with load all for several", () => {
    usePrivacy.setState({ autoPreview: "never" });
    render(<MessageAttachments items={[image("n1"), image("n2"), image("n3")]} own inRoom />);
    expect(screen.getAllByTestId("preview-placeholder")).toHaveLength(3);
    fireEvent.click(screen.getAllByTestId("preview-load")[0]!);
    expect(screen.getAllByTestId("preview-placeholder")).toHaveLength(2);
    fireEvent.click(screen.getByTestId("preview-load-all"));
    expect(screen.queryByTestId("preview-placeholder")).toBeNull();
    expect(screen.getAllByTestId("attachment-image")).toHaveLength(3);
    expect(screen.queryByTestId("preview-load-all")).toBeNull();
  });

  it("a preview loaded by hand stays loaded when the row is rendered again (virtualized list)", () => {
    usePrivacy.setState({ autoPreview: "never" });
    const first = render(<MessageAttachments items={[image("r1")]} />);
    fireEvent.click(screen.getByTestId("preview-load"));
    first.unmount();
    render(<MessageAttachments items={[image("r1"), image("r2")]} />);
    expect(screen.getAllByTestId("attachment-image")).toHaveLength(1);
    expect(screen.getByTestId("preview-placeholder")).toHaveTextContent("r2.png");
  });

  it("images over the cap wait even with always", () => {
    usePrivacy.setState({ autoPreview: "always" });
    render(<MessageAttachments items={[image("small", 5000), image("big", 5001)]} author="stranger@t.local" />);
    expect(screen.getAllByTestId("attachment-image")).toHaveLength(1);
    expect(screen.getByTestId("preview-placeholder")).toHaveTextContent("big.png");
    expect(screen.queryByTestId("preview-load-all")).toBeNull();
  });

  it("SVG is never an inline image, only a file to download", () => {
    usePrivacy.setState({ autoPreview: "always" });
    render(
      <MessageAttachments
        items={[
          { id: "s1", name: "logo.svg", mime: "image/svg+xml", size: 10, encrypted: null },
          { id: "s2", name: "tricky.svg", mime: "image/png", size: 10, encrypted: null },
        ]}
        own
        inRoom
      />,
    );
    expect(screen.queryByTestId("attachment-image")).toBeNull();
    expect(screen.queryByTestId("preview-placeholder")).toBeNull();
    expect(screen.getAllByTestId("attachment-file")).toHaveLength(2);
    expect(screen.getAllByTestId("attachment-download")).toHaveLength(2);
    expect(mediaKind("image/svg+xml")).toBe("file");
    expect(mediaKind("image/webp")).toBe("image");
  });
});
