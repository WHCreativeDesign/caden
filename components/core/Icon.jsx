import React from "react";

/**
 * Icon — curated line-icon set in Caden's stroke style (24px grid, 1.7 stroke,
 * round caps + joins). Self-contained: no icon font, no external dependency.
 * Matches Lucide so unlisted icons can be swapped in 1:1.
 */
const PATHS = {
  mic: <><rect x="9" y="2.5" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0" /><path d="M12 17.5V21" /><path d="M8.5 21h7" /></>,
  send: <path d="M4 12l16-7-7 16-2-7-7-2Z" />,
  chat: <path d="M21 12a8 8 0 0 1-11.5 7.2L3 21l1.8-6.5A8 8 0 1 1 21 12Z" />,
  activity: <path d="M3 12h4l2 6 4-14 2 8h6" />,
  shield: <><path d="M12 3l7 3v5c0 4.4-3 8-7 10-4-2-7-5.6-7-10V6l7-3Z" /><path d="M9.5 12l1.8 1.8L15 10" /></>,
  device: <><rect x="2.5" y="4" width="13" height="9" rx="1.5" /><rect x="17" y="8" width="4.5" height="11" rx="1.2" /><path d="M6 17h5" /></>,
  wrench: <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17v3h3l5.3-5.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.1-2.1Z" />,
  user: <><circle cx="12" cy="8" r="3.2" /><path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  bell: <><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z" /><path d="M10.5 19a1.6 1.6 0 0 0 3 0" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  arrowRight: <path d="M5 12h14M13 6l6 6-6 6" />,
  sparkle: <path d="M12 3l1.6 5.2L19 10l-5.4 1.8L12 17l-1.6-5.2L5 10l5.4-1.8L12 3Z" />,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2 12h2M20 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" /></>,
  home: <><path d="M4 11l8-7 8 7" /><path d="M6 10v9h12v-9" /></>,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  pause: <><path d="M9 5v14M15 5v14" /></>,
  check: <path d="M5 12.5l4.2 4.2L19 7" />,
};

export function Icon({ name, size = 20, stroke = 1.7, style = {}, ...rest }) {
  const glyph = PATHS[name] || PATHS.sparkle;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ display: "block", flex: "0 0 auto", ...style }}
      {...rest}
    >
      {glyph}
    </svg>
  );
}

/** Names available in the curated set. */
export const ICON_NAMES = Object.keys(PATHS);
