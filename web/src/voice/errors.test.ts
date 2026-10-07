// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { TavrnApiError } from "@tavrn/sdk";
import { VoiceError, voiceErrorMessage } from "./errors";
import { useLocale } from "../i18n";

const api = (code: string, status: number, meta?: Record<string, unknown>) => new TavrnApiError({ type: "about:blank", title: "", status, detail: "server text", code, ...(meta ? { meta } : {}) });

describe("voice error mapping (VOICE.md §9)", () => {
  it("names the user limit of a full channel", () => {
    useLocale.setState({ locale: "en" });
    expect(voiceErrorMessage(api("voice.channel_full", 409, { user_limit: 5 }))).toBe("This voice channel is full (at most 5 participants).");
    useLocale.setState({ locale: "de" });
    expect(voiceErrorMessage(api("voice.channel_full", 409, { user_limit: 1 }))).toBe("Dieser Sprachkanal ist voll (höchstens 1 Teilnehmer).");
    useLocale.setState({ locale: "en" });
  });

  it("translates the codes of §3, §5, §7 and §8", () => {
    useLocale.setState({ locale: "en" });
    for (const code of ["voice.connect_forbidden", "voice.disabled", "voice.unavailable", "voice.server_muted", "voice.stream_forbidden", "voice.camera_forbidden", "voice.not_connected", "voice.mute_forbidden", "voice.move_forbidden", "voice.target_forbidden", "voice.not_voice_channel", "voice.same_channel", "voice.token_invalid", "voice.connect_refused", "soundboard.too_large", "soundboard.too_long", "soundboard.type_not_allowed", "soundboard.limit", "soundboard.name_taken", "soundboard.name_invalid", "soundboard.manage_forbidden"]) {
      const text = voiceErrorMessage(api(code, 403));
      expect(text, code).not.toBe("server text");
      expect(text, code).not.toContain(code);
    }
  });

  it("explains local failures: no insertable streams, locked keys, microphone access", () => {
    useLocale.setState({ locale: "en" });
    expect(voiceErrorMessage(new VoiceError("e2ee_unsupported"))).toMatch(/end-to-end/i);
    expect(voiceErrorMessage(new VoiceError("locked"))).toMatch(/unlock/i);
    expect(voiceErrorMessage(Object.assign(new Error("x"), { name: "NotAllowedError" }))).toMatch(/microphone/i);
    expect(voiceErrorMessage(Object.assign(new Error("x"), { name: "NotFoundError" }))).toMatch(/no microphone/i);
  });

  it("maps LiveKit connection failures by HTTP status of the /rtc proxy", () => {
    useLocale.setState({ locale: "en" });
    const lk = (status: number) => Object.assign(new Error("could not establish signal connection"), { name: "ConnectionError", status });
    expect(voiceErrorMessage(lk(502))).toBe(voiceErrorMessage(api("voice.unavailable", 502)));
    expect(voiceErrorMessage(lk(403))).toBe(voiceErrorMessage(api("voice.connect_forbidden", 403)));
    expect(voiceErrorMessage(lk(0))).toMatch(/voice server/i);
  });
});
