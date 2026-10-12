// SPDX-License-Identifier: Apache-2.0
/** Small stroke icons for the voice UI on the client's icon base (`components/icons.tsx`). */
import { Svg, type IconProps } from "../../components/icons";

export { GearIcon } from "../../components/icons";

export const MicIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </Svg>
);

export const MicOffIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15 9.3V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.6 2.5M19 11a7 7 0 0 1-1.2 3.9M5 11a7 7 0 0 0 10.6 6M12 18v3M3 3l18 18" />
  </Svg>
);

export const HeadphonesIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 15v-3a8 8 0 0 1 16 0v3" />
    <rect x="3" y="14" width="5" height="7" rx="2" />
    <rect x="16" y="14" width="5" height="7" rx="2" />
  </Svg>
);

export const HeadphonesOffIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 15v-3a8 8 0 0 1 12.7-6.5M20 12v3" />
    <rect x="3" y="14" width="5" height="7" rx="2" />
    <path d="M16 18v1a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3M3 3l18 18" />
  </Svg>
);

export const VideoIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2" y="6" width="14" height="12" rx="2" />
    <path d="m16 10 6-3v10l-6-3" />
  </Svg>
);

export const ScreenIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2" y="4" width="20" height="13" rx="2" />
    <path d="M8 21h8M12 17v4" />
  </Svg>
);

/** Leaving a stream: the screen, crossed out. */
export const ScreenOffIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 4h12a2 2 0 0 1 2 2v9a2 2 0 0 1-1 1.7M16 17H4a2 2 0 0 1-2-2V6a2 2 0 0 1 1.5-1.9M8 21h8M12 17v4M2 2l20 20" />
  </Svg>
);

export const LeaveIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10.7 13.3a16 16 0 0 0 3.4 2.6l1.3-1.3a2 2 0 0 1 2.1-.5c.8.3 1.6.5 2.4.6a2 2 0 0 1 1.7 2v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 2.3 4.2 2 2 0 0 1 4.3 2h3a2 2 0 0 1 2 1.7c.1.8.3 1.6.6 2.4a2 2 0 0 1-.5 2.1L8 9.6" />
    <path d="M22 2 2 22" />
  </Svg>
);

export const SoundboardIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 18V5l12-2v13" />
    <circle cx="6" cy="18" r="3" />
    <circle cx="18" cy="16" r="3" />
  </Svg>
);

export const SpeakerIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M11 5 6 9H2v6h4l5 4V5z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14" />
  </Svg>
);

export const BluetoothIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m7 7 10 10-5 5V2l5 5L7 17" />
  </Svg>
);

export const PipIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2" y="4" width="20" height="16" rx="2" />
    <rect x="12" y="12" width="8" height="6" rx="1" />
  </Svg>
);

export const ExpandIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
  </Svg>
);

/** Priority speaker (design note 4.13 item 3). */
export const MegaphoneIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 11v2a1 1 0 0 0 1 1h3l7 4V6L7 10H4a1 1 0 0 0-1 1z" />
    <path d="M7 14l1.5 5h2.5l-1-4.4M18 9a4 4 0 0 1 0 6" />
  </Svg>
);

/**
 * Connection quality as three bars (`level` 0–3). `locked`: the end-to-end encrypted variant with a small padlock
 * at the bottom right (16 px; the caller names both, encryption and quality, in its text alternative).
 */
export function SignalBars({ level, className = "", locked = false }: { level: number; className?: string; locked?: boolean }) {
  if (!locked)
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" className={`shrink-0 ${className}`}>
        {[0, 1, 2].map((i) => (
          <rect key={i} data-bar={i} x={1 + i * 4.5} y={9 - i * 3.5} width="3" height={4 + i * 3.5} rx="0.8" fill="currentColor" opacity={i < level ? 1 : 0.25} />
        ))}
      </svg>
    );
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false" className={`shrink-0 ${className}`}>
      {[0, 1, 2].map((i) => (
        <rect key={i} data-bar={i} x={0.5 + i * 3} y={10.5 - i * 3.5} width="2.2" height={4.5 + i * 3.5} rx="0.6" fill="currentColor" opacity={i < level ? 1 : 0.25} />
      ))}
      <g data-testid="signal-lock">
        <path d="M10.6 10V8.4a1.9 1.9 0 0 1 3.8 0V10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        <rect x="9.6" y="10" width="5.8" height="5" rx="1" fill="currentColor" />
      </g>
    </svg>
  );
}

/** An unplugged plug: connection problems of a participant (design note 4.5 item 7). */
export const PlugOffIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 2v4M15 2v4M7 6h10v4a5 5 0 0 1-5 5 5 5 0 0 1-5-5V6zM12 15v3a3 3 0 0 0 3 3h2" />
    <path d="M3 3l18 18" />
  </Svg>
);

export const PhoneIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2Z" />
  </Svg>
);

export const PhoneOffIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10.7 13.3a16 16 0 0 0 3.3 2.5l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 3.1 4.2 2 2 0 0 1 5.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L9 9.8M2 22 22 2" />
  </Svg>
);

export const MinimizeIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />
  </Svg>
);

export const FullscreenIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
  </Svg>
);

export const ExitFullscreenIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
  </Svg>
);
