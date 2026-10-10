// SPDX-License-Identifier: Apache-2.0
/**
 * Native notifications (docs/DESKTOP.md "Notifications", the Tauri shell's `notify.rs`): the client asks for one while
 * the window is not focused (mentions, direct messages, incoming calls; never the content of an encrypted message, the
 * client sends a fixed text instead). Shown with Electron's `Notification` (libnotify, the desktop's notification
 * server over D-Bus), with the app's icon.
 *
 * A click (the server's default action; GNOME, KDE and most others support it) brings the main window to the front,
 * also out of the tray, and sends the notification's path to the client (`shell_events` `{ kind: "open", path }`). A
 * notification is kept referenced until it is clicked or closed, or Electron would drop its click handler; at most
 * {@link MAX_WAITING} wait at once, later ones are shown without a click handler. Without a notification server
 * nothing is shown and the call still succeeds (as in the Tauri shell).
 */
import type { BridgeEvent } from "./events.ts";
import { check, type IpcRegistry } from "./ipc.ts";

export const MAX_TITLE = 200;
export const MAX_BODY = 1000;
/** Longest path (bytes, as the Tauri shell counts). */
export const MAX_PATH = 512;
/** Notifications whose click is awaited at the same time. */
export const MAX_WAITING = 16;

/** `NativeNotice` of the client's bridge. */
export interface Notice {
  title: string;
  body: string;
  /** A path of the client (`/rooms/…`, `/dm/…`) to open on a click. */
  path?: string | null;
}

/** Unicode control characters (category Cc), as Rust's `char::is_control`. */
const isControl = (c: string) => {
  const code = c.codePointAt(0) ?? 0;
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
};
const textOk = (s: string, max: number) => {
  const chars = [...s];
  return chars.length <= max && !chars.some((c) => isControl(c) && c !== "\n");
};

/** Lengths, no control characters, and a path that stays inside the client (no scheme, no `//host`). */
export function validateNotice(n: Notice): void {
  if (!n.title.trim() || !textOk(n.title, MAX_TITLE) || !textOk(n.body, MAX_BODY)) throw "notify.invalid";
  const path = n.path;
  if (path != null) {
    const inside = path.startsWith("/") && !path.startsWith("//") && Buffer.byteLength(path) <= MAX_PATH;
    if (!inside || [...path].some((c) => isControl(c) || c === "\\" || /\s/u.test(c))) throw "notify.invalid";
  }
}

/** What the notifier hands to Electron's `Notification` constructor. */
export interface NotificationOptions {
  title: string;
  body: string;
  icon?: string;
}

/** The part of Electron's `Notification` the notifier uses. */
export interface NotificationLike {
  on(event: "click" | "close" | "failed", listener: () => void): unknown;
  show(): void;
}

export interface NotifierDeps {
  create(options: NotificationOptions): NotificationLike;
  /** A notification server answers (`Notification.isSupported()`). */
  supported(): boolean;
  /** Brings the main window to the front (also out of the tray). */
  showMain(): void;
  events: { send(event: BridgeEvent): boolean };
  /** The app icon's file. */
  icon?: string;
}

export class Notifier {
  readonly #deps: NotifierDeps;
  readonly #waiting = new Set<NotificationLike>();

  constructor(deps: NotifierDeps) {
    this.#deps = deps;
  }

  /** Notifications waiting for a click. */
  get waiting(): number {
    return this.#waiting.size;
  }

  /** Shows a valid notice (throws `notify.invalid`); a click focuses the window and opens its path. */
  notify(notice: Notice): void {
    validateNotice(notice);
    if (!this.#deps.supported()) return;
    const options: NotificationOptions = { title: notice.title, body: notice.body };
    if (this.#deps.icon) options.icon = this.#deps.icon;
    const n = this.#deps.create(options);
    if (this.#waiting.size < MAX_WAITING) {
      this.#waiting.add(n);
      const done = () => void this.#waiting.delete(n);
      n.on("click", () => {
        done();
        this.#deps.showMain();
        if (notice.path) this.#deps.events.send({ channel: "shell_events", event: { kind: "open", path: notice.path } });
      });
      n.on("close", done);
      n.on("failed", done);
    }
    n.show();
  }
}

const optionalPath = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.length <= MAX_PATH * 4);

/** The `notify` namespace of the bridge. */
export function registerNotifyHandlers(registry: IpcRegistry, deps: { notifier: Notifier }): void {
  const notice = check.record({ title: check.string(MAX_TITLE * 4), body: check.string(MAX_BODY * 4), path: optionalPath });
  registry.handle("notify", "notify", check.args([notice]), (n: Notice) => deps.notifier.notify(n));
}
