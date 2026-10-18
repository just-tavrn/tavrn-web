// SPDX-License-Identifier: Apache-2.0
/** Reserved audio publications must never enter ordinary audio or stream playback. */
export const isWhisperTrack = (name?: string): boolean => name === "whisper" || !!name?.startsWith("whisper:");
export const whisperSessionId = (name?: string): string | null => name?.startsWith("whisper:") && /^[A-Za-z0-9_-]{1,128}$/.test(name.slice(8)) ? name.slice(8) : null;
