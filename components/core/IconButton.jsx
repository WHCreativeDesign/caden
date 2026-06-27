import React from "react";
import { Icon } from "./Icon.jsx";

/**
 * IconButton — a round, quiet control for a single glyph. Soft warm hover well.
 * tone: "default" | "ink" (dark panels) | "accent".
 */
export function IconButton({
  name,
  size = 40,
  iconSize,
  tone = "default",
  label,
  style = {},
  ...rest
}) {
  const tones = {
    default: { color: "var(--text-muted)", hoverBg: "var(--bg-2)" },
    ink: { color: "var(--text-on-ink-muted)", hoverBg: "rgba(243,233,218,0.08)" },
    accent: { color: "var(--accent)", hoverBg: "var(--accent-wash)" },
  };
  const t = tones[tone] || tones.default;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="caden-iconbtn"
      style={{
        width: size,
        height: size,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "var(--r-pill)",
        color: t.color,
        background: "transparent",
        transition: "background var(--dur) var(--ease), color var(--dur) var(--ease)",
        "--hb": t.hoverBg,
        ...style,
      }}
      {...rest}
    >
      <Icon name={name} size={iconSize || Math.round(size * 0.5)} />
    </button>
  );
}
