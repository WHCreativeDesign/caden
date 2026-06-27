import React from "react";
import type { IconName } from "./Icon";

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  name: IconName;
  /** Button diameter. Default 40. */
  size?: number;
  /** Icon glyph size (defaults to ~half the button). */
  iconSize?: number;
  tone?: "default" | "ink" | "accent";
  /** Accessible label (required for icon-only controls). */
  label?: string;
}

/** Round, quiet single-glyph control with a soft warm hover well. */
export function IconButton(props: IconButtonProps): JSX.Element;
