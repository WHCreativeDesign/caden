import React from "react";
import { Icon } from "./Icon.jsx";

/**
 * Button — Caden's primary action. Warm, soft-cornered, calm motion.
 * Variants: primary (terracotta), ghost (paper + warm border), quiet (text),
 * ink (for use on dark espresso panels). Sizes: sm | md | lg.
 */
export function Button({
  children,
  variant = "primary",
  size = "md",
  icon,
  iconRight,
  block = false,
  disabled = false,
  style = {},
  ...rest
}) {
  const sizes = {
    sm: { padding: "8px 14px", fontSize: "var(--t-small)", radius: "var(--r-sm)", gap: 7 },
    md: { padding: "12px 20px", fontSize: "var(--t-small)", radius: "var(--r)", gap: 8 },
    lg: { padding: "15px 26px", fontSize: "var(--t-body)", radius: "var(--r-lg)", gap: 10 },
  };
  const sz = sizes[size] || sizes.md;

  const base = {
    display: block ? "flex" : "inline-flex",
    width: block ? "100%" : undefined,
    alignItems: "center",
    justifyContent: "center",
    gap: sz.gap,
    fontFamily: "var(--font-mono)",
    fontSize: sz.fontSize,
    fontWeight: 500,
    letterSpacing: "0.01em",
    padding: sz.padding,
    borderRadius: sz.radius,
    border: "1px solid transparent",
    transition:
      "transform var(--dur) var(--ease), background var(--dur) var(--ease), border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease)",
    whiteSpace: "nowrap",
    opacity: disabled ? 0.5 : 1,
    pointerEvents: disabled ? "none" : "auto",
    cursor: "pointer",
  };

  const variants = {
    primary: {
      background: "var(--accent)",
      color: "var(--text-on-accent)",
      fontWeight: 600,
      boxShadow: "var(--shadow-sm)",
    },
    ghost: {
      background: "var(--surface)",
      borderColor: "var(--border-strong)",
      color: "var(--text)",
    },
    quiet: {
      background: "transparent",
      color: "var(--text-muted)",
    },
    ink: {
      background: "rgba(243,233,218,0.08)",
      borderColor: "var(--border-ink)",
      color: "var(--text-on-ink)",
    },
  };

  return (
    <button
      type="button"
      disabled={disabled}
      className={`caden-btn caden-btn--${variant}`}
      style={{ ...base, ...(variants[variant] || variants.primary), ...style }}
      {...rest}
    >
      {icon && <Icon name={icon} size={size === "lg" ? 19 : 16} />}
      {children}
      {iconRight && <Icon name={iconRight} size={size === "lg" ? 19 : 16} />}
    </button>
  );
}
