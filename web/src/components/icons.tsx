// SPDX-License-Identifier: Apache-2.0
/**
 * The client's stroke icons (24×24 viewBox, 2 px stroke, `currentColor`), decorative by default: the control
 * that shows one carries the accessible name. The voice UI adds its own glyphs on the same base
 * (`voice/ui/icons.tsx`).
 */
import type { ReactNode } from "react";

export type IconProps = { size?: number; className?: string; "data-testid"?: string; "data-icon"?: string };

export function Svg({ size = 18, children, className = "", ...data }: IconProps & { children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className={`shrink-0 ${className}`} {...data}>
      {children}
    </svg>
  );
}

export const GearIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </Svg>
);

export const BellIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
  </Svg>
);

export const ChevronDownIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 9l6 6 6-6" />
  </Svg>
);

/** Node administration. */
export const WrenchIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  </Svg>
);

/** End-to-end encrypted. */
export const LockIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </Svg>
);

/** A verified contact (FEDERATION.md §10): a shield with a check mark, the compact marker of member lists. */
export const ShieldCheckIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6z" />
    <path d="M9 12l2 2 4-4" />
  </Svg>
);

/** Not end-to-end encrypted (the shackle open). */
export const UnlockIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 7.75-1.4" />
  </Svg>
);

/** Hidden text (spoiler): the eye struck through. */
export const EyeOffIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
    <path d="M10.73 5.08A10.4 10.4 0 0 1 12 5c7 0 10 7 10 7a13.2 13.2 0 0 1-1.67 2.68" />
    <path d="M6.61 6.61A13.5 13.5 0 0 0 2 12s3 7 10 7a9.7 9.7 0 0 0 5.39-1.61" />
    <path d="M2 2l20 20" />
  </Svg>
);

/** "No entry" (a circle with a diagonal bar): the viewer may see a channel but not use it. */
export const NoEntryIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M5.6 5.6l12.8 12.8" />
  </Svg>
);

/** A group of two people with a slash: a channel only certain roles may see or join. */
export const GroupOffIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="8" r="3" />
    <path d="M3 20v-1a5 5 0 0 1 9-3" />
    <path d="M15.5 5.3a3 3 0 0 1 1.6 4.6" />
    <path d="M18 14a5 5 0 0 1 3 5v1" />
    <path d="M3 3l18 18" />
  </Svg>
);

/** A text channel: the hash sign. */
export const HashIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" />
  </Svg>
);

/** A files channel, a folder. */
export const FolderIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Svg>
);

/** A forum channel: two speech bubbles (posts with their threads). */
export const ForumIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 9a2 2 0 0 1-2 2H6l-3 3V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2z" />
    <path d="M18 9h1a2 2 0 0 1 2 2v10l-3-3h-6a2 2 0 0 1-2-2v-1" />
  </Svg>
);

/** An announcement channel: a megaphone. */
export const AnnouncementIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 11v2a1 1 0 0 0 1 1h3l9 5V5L7 10H4a1 1 0 0 0-1 1z" />
    <path d="M7 14l1.5 5h2.5l-1-4.4M19.5 9.5a3.5 3.5 0 0 1 0 5" />
  </Svg>
);

/** The welcome channel: a four-pointed sparkle. */
export const SparkleIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3c.6 4.6 2.4 6.4 7 7-4.6.6-6.4 2.4-7 7-.6-4.6-2.4-6.4-7-7 4.6-.6 6.4-2.4 7-7z" />
    <path d="M19 16v4M17 18h4" />
  </Svg>
);

export const PlusIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

/** Notifications muted: the bell struck through. */
export const BellOffIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8.7 3.7A6 6 0 0 1 18 8c0 2.7.4 4.6 1 6M17 17H3s3-2 3-9c0-.7.1-1.4.3-2" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    <path d="M2 2l20 20" />
  </Svg>
);

/** A bot (APPLICATIONS.md): a robot head. */
export const BotIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="8" width="16" height="12" rx="2" />
    <path d="M12 8V4M9 13v2M15 13v2" />
  </Svg>
);

/** No bots: the robot head struck through. */
export const BotOffIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 8h9a2 2 0 0 1 2 2v7M18 20H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 1.5-1.9" />
    <path d="M12 8V4M9 13v2" />
    <path d="M2 2l20 20" />
  </Svg>
);

/** Friends: two people. */
export const UsersIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="8" r="3" />
    <path d="M3 20v-1a5 5 0 0 1 10 0v1" />
    <path d="M15.5 5.3a3 3 0 0 1 0 5.4M18 14a5 5 0 0 1 3 5v1" />
  </Svg>
);

/** Message requests: an envelope. */
export const MailIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="m3 7 9 6 9-6" />
  </Svg>
);
