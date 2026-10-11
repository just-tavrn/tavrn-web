// SPDX-License-Identifier: Apache-2.0
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Profile } from "@tavrn/sdk";
import { mockFetch, renderWithProviders } from "../test/render";
import { ProfileView } from "./ProfilePopover";

const profile = (links: Profile["links"]) =>
  ({ address: "eve@far.test", username: "eve", display_name: "Eve", kind: "user", bio: null, links, avatar_blob_id: null, banner_blob_id: null, created_at: "" }) as unknown as Profile;

describe("profile links from another node", () => {
  it("link only to http(s) and mailto URLs, show the target, and keep anything else as text", () => {
    mockFetch({});
    renderWithProviders(
      <ProfileView
        profile={profile([
          { service: "github", value: "eve", url: "https://phish.example/login" },
          { service: "website", value: "evil", url: "javascript:alert(1)" },
          { service: "email", value: "eve@far.test", url: "mailto:eve@far.test" },
        ] as Profile["links"])}
      />,
    );
    const links = screen.getByTestId("profile-links").querySelectorAll("a");
    expect([...links].map((a) => a.getAttribute("href"))).toEqual(["https://phish.example/login", "mailto:eve@far.test"]);
    expect(links[0]).toHaveAttribute("title", "https://phish.example/login");
    expect(screen.getByText("evil").closest("a")).toBeNull();
  });
});
