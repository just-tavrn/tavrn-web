// SPDX-License-Identifier: Apache-2.0
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const STILL = "https://n.example/api/v1/media/A";
const ANIM = "https://n.example/api/v1/media/A/animated";

vi.mock("../../pages/ChannelPage", () => ({ useRoomMembers: () => ({ data: [] }) }));
vi.mock("../../components/Avatar", async (original) => ({
  ...(await original<typeof import("../../components/Avatar")>()),
  useAvatarUrls: () => ({ still: STILL, animated: ANIM }),
}));

const { AvatarTile } = await import("./AvatarTile");

const src = () => screen.getByTestId("avatar-image").getAttribute("src");
const tile = () => document.querySelector(".voice-avatar")!;

describe("AvatarTile (design note 4.5 item 6)", () => {
  it("on the stage shows the still frame and animates only while the participant speaks", () => {
    const { rerender } = render(<AvatarTile roomId="r" name="Alice" address="alice@n.example" size={72} stage />);
    expect(src()).toBe(STILL);
    expect(tile()).not.toHaveAttribute("data-animate");
    // No hover animation on the stage.
    fireEvent.pointerEnter(screen.getByTestId("avatar-image").parentElement!, { pointerType: "mouse" });
    expect(src()).toBe(STILL);
    rerender(<AvatarTile roomId="r" name="Alice" address="alice@n.example" size={72} stage speaking />);
    expect(src()).toBe(ANIM);
    expect(tile()).toHaveAttribute("data-animate", "true");
    rerender(<AvatarTile roomId="r" name="Alice" address="alice@n.example" size={72} stage speaking={false} />);
    expect(src()).toBe(STILL);
  });

  it("in lists animates on hover and while speaking", () => {
    const { rerender } = render(<AvatarTile roomId="r" name="Alice" address="alice@n.example" size={24} />);
    expect(src()).toBe(STILL);
    fireEvent.pointerEnter(screen.getByTestId("avatar-image").parentElement!, { pointerType: "mouse" });
    expect(src()).toBe(ANIM);
    rerender(<AvatarTile roomId="r" name="Alice" address="alice@n.example" size={24} speaking />);
    expect(src()).toBe(ANIM);
  });

  it("takes the user directly where there is no room (calls)", () => {
    render(<AvatarTile user={{ address: "bob@n.example" } as never} name="Bob" address="bob@n.example" size={44} stage />);
    expect(src()).toBe(STILL);
  });
});
