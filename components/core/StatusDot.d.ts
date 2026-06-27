import React from "react";

export interface StatusDotProps {
  tone?: "on" | "idle" | "error" | "accent" | "off";
  /** Emit a slow pulse ring (for live/running states). */
  pulse?: boolean;
  size?: number;
  style?: React.CSSProperties;
}

/** Caden's status primitive — a washed dot, optionally pulsing. Never emoji. */
export function StatusDot(props: StatusDotProps): JSX.Element;
