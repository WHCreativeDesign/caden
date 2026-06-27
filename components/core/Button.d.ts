import React from "react";
import type { IconName } from "./Icon";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual style. Default "primary". */
  variant?: "primary" | "ghost" | "quiet" | "ink";
  /** Size. Default "md". */
  size?: "sm" | "md" | "lg";
  /** Leading icon name. */
  icon?: IconName;
  /** Trailing icon name (e.g. "arrowRight"). */
  iconRight?: IconName;
  /** Full-width. */
  block?: boolean;
  disabled?: boolean;
}

/**
 * The brand's action button — terracotta primary, warm ghost, quiet text, and
 * an ink variant for dark espresso panels. Mono label, soft corners, calm press.
 *
 * @startingPoint section="Caden" subtitle="Action button — 4 warm variants" viewport="520x120"
 */
export function Button(props: ButtonProps): JSX.Element;
