// SPDX-License-Identifier: Apache-2.0
/**
 * Translated messages for voice failures (VOICE.md §9 "Errors"): API problem codes of §3, §5, §7, §8,
 * LiveKit connection errors (by the HTTP status of the node's `/rtc` proxy) and local failures.
 */
import { TavrnApiError } from "@tavrn/sdk";
import { t } from "../i18n";
import { describeError } from "../stores/toasts";
import { platform } from "../platform";
import { androidMediaBlocked } from "./androidMedia";

export type VoiceErrorCode = "e2ee_unsupported" | "e2ee_failed" | "locked" | "no_group" | "connect_failed" | "busy" | "native_device" | "native_unavailable";

/** A failure on this device before or while connecting. */
export class VoiceError extends Error {
  constructor(readonly code: VoiceErrorCode) {
    super(code);
    this.name = "VoiceError";
  }
}

const RTC_STATUS: Record<number, string> = { 401: "voice.token_invalid", 403: "voice.connect_forbidden", 502: "voice.unavailable", 503: "voice.disabled" };

export function voiceErrorMessage(e: unknown): string {
  if (e instanceof VoiceError) return t(`voice.error.${e.code}`);
  if (e instanceof TavrnApiError) {
    if (e.code === "voice.channel_full") {
      const limit = (e.problem as { meta?: { user_limit?: number } }).meta?.user_limit;
      return t("voice.error.channel_full", { limit: limit ?? "?" });
    }
    return describeError(e);
  }
  const named = e as { name?: string; status?: number } | null;
  // getUserMedia: permission denied or no device.
  if (named?.name === "NotAllowedError" || named?.name === "SecurityError") return t(platform().android ? (androidMediaBlocked() ? "voice.error.media_blocked_android" : "voice.error.mic_denied_android") : "voice.error.mic_denied");
  if (named?.name === "NotFoundError" || named?.name === "OverconstrainedError") return t("voice.error.mic_missing");
  if (named?.name === "NotReadableError") return t("voice.error.mic_busy");
  // livekit-client's ConnectionError carries the HTTP status of the failed validation request.
  if (named?.name === "ConnectionError") {
    const code = named.status ? RTC_STATUS[named.status] : undefined;
    return code ? t(`errors.${code}`) : t("voice.error.connect_failed");
  }
  return describeError(e);
}
