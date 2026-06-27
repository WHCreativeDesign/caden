import React from "react";

export type IconName =
  | "mic" | "send" | "chat" | "activity" | "shield" | "device" | "wrench"
  | "user" | "clock" | "bell" | "plus" | "arrowRight" | "sparkle" | "sun"
  | "home" | "x" | "pause" | "check";

export interface IconProps {
  /** Icon name from the curated set. */
  name: IconName;
  /** Pixel size (square). Default 20. */
  size?: number;
  /** Stroke width. Default 1.7. */
  stroke?: number;
  style?: React.CSSProperties;
}

/** Line icon in Caden's stroke style (Lucide-compatible 24px grid). */
export function Icon(props: IconProps): JSX.Element;
export const ICON_NAMES: string[];
