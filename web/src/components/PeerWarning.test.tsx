// SPDX-License-Identifier: Apache-2.0
import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { KeyFingerprint, PeerPublicState } from "@tavrn/sdk";
import { renderWithProviders } from "../test/render";
import { PeerWarning, fingerprints, keysDiffer, peerDeps } from "./PeerWarning";

const original = { ...peerDeps };
afterEach(() => Object.assign(peerDeps, original));

function setup(state: Partial<PeerPublicState> | Error, own: KeyFingerprint[] | null = null) {
  peerDeps.state = async () => {
    if (state instanceof Error) throw state;
    return { domain: "b.test", conformance: "pass", blocked: false, keys: [], ...state };
  };
  peerDeps.ownKeys = async () => own;
}

function view(quiet = false) {
  return renderWithProviders(
    <PeerWarning domain="b.test" quiet={quiet}>
      <p>room content</p>
    </PeerWarning>,
  );
}

describe("client checks of other nodes (FEDERATION.md §9.2)", () => {
  it("shows the content of a node that passed", async () => {
    setup({ conformance: "pass" });
    view();
    expect(await screen.findByText("room content")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("warns above the content of a node that failed the check", async () => {
    setup({ conformance: "fail" });
    view();
    expect(await screen.findByTestId("peer-failed-check")).toHaveTextContent("Sicherheitsprüfung nicht bestanden");
    expect(screen.getByText("room content")).toBeInTheDocument();
  });

  it("replaces the content of a blocked node", async () => {
    setup({ blocked: true, conformance: "fail" });
    view();
    expect(await screen.findByTestId("peer-blocked")).toHaveTextContent("föderiert nicht mit b.test");
    expect(screen.queryByText("room content")).not.toBeInTheDocument();
  });

  it("replaces the content when the keys differ from the home node's view", async () => {
    setup({ keys: [{ kid: "k1", sha256: "AAA" }] }, [{ kid: "k1", sha256: "BBB" }]);
    view();
    expect(await screen.findByTestId("peer-keys-differ")).toHaveTextContent("b.test");
    expect(screen.queryByText("room content")).not.toBeInTheDocument();
  });

  it("shows nothing extra when the home node cannot be asked, and quiet scopes show no banner", async () => {
    setup(new Error("offline"));
    const first = view();
    expect(await screen.findByText("room content")).toBeInTheDocument();
    first.unmount();
    setup({ conformance: "fail" });
    view(true);
    expect(await screen.findByText("room content")).toBeInTheDocument();
    expect(screen.queryByTestId("peer-failed-check")).not.toBeInTheDocument();
  });

  it("compares fingerprints by kid only where both views know the kid", async () => {
    const own = await fingerprints([{ kid: "k1", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" }]);
    expect(own[0]!.kid).toBe("k1");
    expect(own[0]!.sha256).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(keysDiffer(own, own)).toBe(false);
    expect(keysDiffer(own, [{ kid: "k2", sha256: "X" }])).toBe(false);
    expect(keysDiffer(own, [{ kid: "k1", sha256: "X" }])).toBe(true);
    expect(keysDiffer(null, [{ kid: "k1", sha256: "X" }])).toBe(false);
  });
});
