// SPDX-License-Identifier: Apache-2.0
/** How poll times read: slots in the viewer's zone (with the creator's wall time when it differs), close times. */
import { allDayDate, type PollSlot } from "./model";
import { offsetMinutes, offsetText, parseRfc3339 } from "./time";

export interface SlotText {
  /** `Mon, Oct 12` in the viewer's zone (all-day slots: the creator's date). */
  date: string;
  /** `14:00 – 15:30`, `14:00`, or empty for all-day slots. */
  time: string;
  allDay: boolean;
  /** The creator's wall time and offset when it differs from the viewer's (`14:00 – 15:30 UTC+02:00`). */
  creator: string | null;
  /** Sort key and day grouping: the viewer's `YYYY-MM-DD`. */
  day: string;
  /** Minute of the day the slot starts at in the viewer's zone (sorts the rows of the results grid; -1: all day). */
  minutes: number;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function slotText(slot: PollSlot, locale: string, timeZone?: string): SlotText {
  if (slot.all_day) {
    const day = allDayDate(slot);
    const [y, m, d] = day.split("-").map(Number) as [number, number, number];
    const date = new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(new Date(Date.UTC(y, m - 1, d)));
    return { date, time: "", allDay: true, creator: null, day, minutes: -1 };
  }
  const start = Date.parse(slot.start);
  const end = slot.end ? Date.parse(slot.end) : null;
  const dateFmt = new Intl.DateTimeFormat(locale, { timeZone, weekday: "short", day: "numeric", month: "short" });
  const timeFmt = new Intl.DateTimeFormat(locale, { timeZone, hour: "2-digit", minute: "2-digit" });
  const time = end !== null ? `${timeFmt.format(start)} – ${timeFmt.format(end)}` : timeFmt.format(start);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(start);
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(start);
  const part = (type: string) => Number(clock.find((p) => p.type === type)?.value ?? 0);
  const minutes = part("hour") * 60 + part("minute");
  const wall = parseRfc3339(slot.start);
  let creator: string | null = null;
  if (wall && wall.offset !== offsetMinutes(start, timeZone)) {
    const endWall = slot.end ? parseRfc3339(slot.end) : null;
    const t = `${pad(wall.hour)}:${pad(wall.minute)}${endWall ? ` – ${pad(endWall.hour)}:${pad(endWall.minute)}` : ""}`;
    creator = `${t} UTC${offsetText(wall.offset)}`;
  }
  return { date: dateFmt.format(start), time, allDay: false, creator, day: parts, minutes };
}

/** A close time in the viewer's zone, with the date. */
export function closeText(iso: string, locale: string, timeZone?: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  return new Intl.DateTimeFormat(locale, { timeZone, dateStyle: "medium", timeStyle: "short" }).format(ms);
}

/** "in 3 hours", "in 2 days" (relative, rounded down to the largest unit; under a minute: "in under a minute"). */
export function relativeUntil(iso: string, now: number, locale: string): string | null {
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "always" });
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return rtf.format(1, "minute");
  if (minutes < 60) return rtf.format(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return rtf.format(hours, "hour");
  return rtf.format(Math.floor(hours / 24), "day");
}
