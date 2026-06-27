import React from "react";

/**
 * StatusDot — the brand's stand-in for status (never emoji). Optional live
 * pulse ring for "running" states.
 * tone: "on" | "idle" | "error" | "accent" | "off"
 */
export function StatusDot({ tone = "on", pulse = false, size = 8, style = {}, ...rest }) {
  const tones = {
    on: { bg: "var(--ok)", wash: "var(--ok-wash)" },
    idle: { bg: "var(--warn)", wash: "var(--warn-wash)" },
    error: { bg: "var(--err)", wash: "var(--err-wash)" },
    accent: { bg: "var(--accent)", wash: "var(--accent-wash)" },
    off: { bg: "var(--text-dim)", wash: "transparent" },
  };
  const t = tones[tone] || tones.on;
  return (
    <span
      aria-hidden="true"
      style={{
        position: "relative",
        display: "inline-block",
        width: size,
        height: size,
        flex: "0 0 auto",
        borderRadius: "50%",
        background: t.bg,
        boxShadow: `0 0 0 3px ${t.wash}`,
        ...style,
      }}
      {...rest}
    >
      {pulse && (
        <span
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "50%",
            background: t.bg,
            animation: "pulse-ring 2.6s var(--ease) infinite",
          }}
        />
      )}
    </span>
  );
}
