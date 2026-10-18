// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { normalizeSettings } from "./settings";
import { actionOfKeyDown, hotkeyConflict } from "./hotkeys";
it("migrates legacy bindings and preserves bounded dynamic whisper keys", () => {
  expect(normalizeSettings({ pttKey: "KeyV" }).hotkeys.push_to_talk).toBe("KeyV");
  const s = normalizeSettings({ hotkeys: { push_to_talk: "KeyV", "whisper:team": "KeyG", whisper_reply: "KeyR", bogus: "KeyB", "whisper:duplicate": "KeyV" }, whisperGroups: { "n/room": [{ id: "team", name: "Team", members: ["a@n", "a@n", "bad", "b@n"] }] } });
  expect(s.hotkeys["whisper:team"]).toBe("KeyG"); expect(s.hotkeys["whisper:duplicate"]).toBe(""); expect(s.hotkeys).not.toHaveProperty("bogus");
  expect(s.whisperGroups["n/room"]![0]!.members).toEqual(["a@n", "b@n"]);
  expect(hotkeyConflict(s.hotkeys, "priority", "KeyG")).toBe("whisper:team");
  expect(actionOfKeyDown(s.hotkeys, { code: "KeyG", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false })).toBe("whisper:team");
});
