// SPDX-License-Identifier: Apache-2.0
// Wiring of the MLS session manager: the tabs of this browser coordinate one MLS state per node, account and device
// (`@tavrn/e2ee` tabs.ts); the KeyPackages of `ensureDevice` are created in the open manager's state.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenMlsOptions } from "@tavrn/e2ee";

const opened: OpenMlsOptions[] = [];
const manager = {
  changedKeys: () => [],
  rotatedKeys: () => [],
  verificationStates: () => ({}),
  restoreBackups: vi.fn(async () => 0),
  processWelcomes: vi.fn(async () => []),
  hasPendingBackups: () => false,
  dispose: vi.fn(),
  createKeyPackages: vi.fn(async (n: number) => Array.from({ length: n }, (_, i) => `kp${i}`)),
  setInboxWanted: vi.fn(),
};

vi.mock("@tavrn/e2ee", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tavrn/e2ee")>();
  return {
    ...actual,
    openMlsManager: vi.fn(async (_store: unknown, opts: OpenMlsOptions) => {
      opened.push(opts);
      return manager;
    }),
  };
});

const flows = vi.hoisted(() => ({ ensureDevice: vi.fn(async (_ctx: unknown) => undefined), syncIdentity: vi.fn(async () => "current" as const) }));
vi.mock("../crypto/e2ee", async (importOriginal) => ({ ...(await importOriginal<typeof import("../crypto/e2ee")>()), ...flows }));

import { cryptoStore } from "../crypto/store";
import { useAuth } from "./auth";
import { useE2ee } from "./e2ee";
import { getMls, mlsTabName, resetMls, syncInboxChannels } from "./mls";

const user = (address: string) => ({ address, username: address.split("@")[0], domain: address.split("@")[1] }) as never;

beforeEach(() => {
  opened.length = 0;
  manager.setInboxWanted.mockClear();
  vi.spyOn(cryptoStore, "isUnlocked").mockReturnValue(true);
  useAuth.setState({ token: "t", user: user("alice@a.test"), deviceId: "DEV1", home: null });
});

afterEach(() => {
  resetMls();
  vi.restoreAllMocks();
});

describe("MLS state shared by the tabs of this browser", () => {
  it("names the lock and channel per home node, account and device", () => {
    expect(mlsTabName("https://a.test", "alice@a.test", "DEV1")).toBe("tavrn-mls|https://a.test|alice@a.test/DEV1");
  });

  it("opens the session manager with tab coordination for the signed-in account", async () => {
    expect(await getMls()).toBe(manager);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.tabs).toEqual({ name: mlsTabName(location.origin, "alice@a.test", "DEV1") });
    // Another account (of another node, signed in here) gets its own owner tab.
    resetMls();
    useAuth.setState({ user: user("bob@b.test"), deviceId: "DEV2", home: { domain: "b.test", base: "https://b.test", ws: "wss://b.test/ws" } as never });
    await getMls();
    expect(opened[1]!.tabs).toEqual({ name: mlsTabName("https://b.test", "bob@b.test", "DEV2") });
  });

  it("ensureDevice creates the KeyPackages in the open manager's state", async () => {
    await useE2ee.getState().ensureDevice();
    expect(flows.ensureDevice).toHaveBeenCalledTimes(1);
    const ctx = flows.ensureDevice.mock.calls[0]![0] as { keyPackages?: (n: number) => Promise<string[] | null> };
    expect(await ctx.keyPackages?.(2)).toEqual(["kp0", "kp1"]);
    expect(manager.createKeyPackages).toHaveBeenCalledWith(2);
  });
});

describe("inbox keys of channels with webhooks (APPLICATIONS.md §6.1a)", () => {
  const channels = [
    { id: "C1", encrypted: true, has_webhooks: true },
    { id: "C2", encrypted: true, has_webhooks: false },
  ];

  it("hands the channels to the open manager", async () => {
    await getMls();
    await syncInboxChannels("a.test", channels);
    expect(manager.setInboxWanted.mock.calls).toEqual([
      ["a.test/C1", true],
      ["a.test/C2", false],
    ]);
  });

  it("keeps what a room showed before the device was unlocked and hands it to the manager once it opens", async () => {
    // The room loads first (right after joining, while the device key is still being set up); the room query is not
    // fetched again, so the manager would otherwise never learn the channel has webhooks and the join commit would
    // publish no inbox key.
    vi.mocked(cryptoStore.isUnlocked).mockReturnValue(false);
    await syncInboxChannels("a.test", channels);
    expect(manager.setInboxWanted).not.toHaveBeenCalled();
    vi.mocked(cryptoStore.isUnlocked).mockReturnValue(true);
    await getMls();
    expect(manager.setInboxWanted.mock.calls).toEqual([
      ["a.test/C1", true],
      ["a.test/C2", false],
    ]);
  });

  it("never hands one account's channels to another account's manager", async () => {
    vi.mocked(cryptoStore.isUnlocked).mockReturnValue(false);
    await syncInboxChannels("a.test", channels);
    resetMls();
    useAuth.setState({ user: user("bob@b.test"), deviceId: "DEV2" });
    vi.mocked(cryptoStore.isUnlocked).mockReturnValue(true);
    await getMls();
    expect(manager.setInboxWanted).not.toHaveBeenCalled();
  });
});
