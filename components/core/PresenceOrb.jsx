import React from "react";

/**
 * PresenceOrb — Caden made visible.
 *
 * A warm, organic blob that breathes and morphs. It is the brand's living
 * anchor: it drifts across the canvas, pulses while listening, rotates while
 * thinking, and steps aside to reveal answers. Built entirely from tokens +
 * the global `caden-*` keyframes (see tokens/motion.css), so it inherits the
 * brand's motion language with no extra CSS.
 *
 * state: "idle" | "listening" | "thinking" | "speaking"
 */
export function PresenceOrb({
  size = 180,
  state = "idle",
  label = "Caden",
  showLabel = false,
  flat = false,
  style = {},
  ...rest
}) {
  const reduce =
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const coreAnim = reduce
    ? "none"
    : state === "listening"
    ? "caden-listen 1.6s var(--ease-soft) infinite, caden-morph 8s var(--ease-soft) infinite"
    : state === "thinking"
    ? "caden-breathe 3.2s var(--ease-soft) infinite, caden-morph 6s var(--ease-soft) infinite"
    : "caden-breathe var(--breathe) var(--ease-soft) infinite, caden-morph var(--morph) var(--ease-soft) infinite";

  const glow =
    state === "listening" || state === "speaking"
      ? "var(--glow-lg)"
      : "var(--glow)";

  const wrap = {
    position: "relative",
    width: size,
    height: size,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flex: "0 0 auto",
    ...style,
  };

  const core = {
    position: "relative",
    width: "100%",
    height: "100%",
    borderRadius: "var(--blob-1)",
    background: flat
      ? "var(--accent)"
      : "radial-gradient(circle at 34% 30%, var(--presence-a) 0%, var(--presence-b) 46%, var(--presence-c) 100%)",
    boxShadow: flat ? "none" : glow,
    animation: flat
      ? (reduce ? "none" : "caden-morph 22s var(--ease-soft) infinite")
      : coreAnim,
    willChange: "transform, border-radius",
  };

  const sheen = {
    position: "absolute",
    inset: "8%",
    borderRadius: "inherit",
    background:
      "conic-gradient(from 0deg, rgba(255,248,241,0) 0%, rgba(255,248,241,0.34) 22%, rgba(255,248,241,0) 48%, rgba(255,248,241,0.18) 72%, rgba(255,248,241,0) 100%)",
    mixBlendMode: "soft-light",
    animation: reduce
      ? "none"
      : `caden-spin ${state === "thinking" ? "3.5s" : "16s"} linear infinite`,
    pointerEvents: "none",
  };

  const highlight = {
    position: "absolute",
    top: "14%",
    left: "20%",
    width: "38%",
    height: "30%",
    borderRadius: "50%",
    background:
      "radial-gradient(circle at 50% 50%, rgba(255,250,243,0.55), rgba(255,250,243,0) 70%)",
    filter: "blur(2px)",
    pointerEvents: "none",
  };

  const showRipples = state === "listening" && !flat && !reduce;

  return (
    <div className="caden-presence" data-state={state} style={wrap} {...rest}>
      {showRipples &&
        [0, 1, 2].map((i) => (
          <span
            key={i}
            aria-hidden="true"
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: "var(--blob-2)",
              border: "1.5px solid var(--accent-line)",
              animation: `caden-ripple 2.4s var(--ease-out) ${i * 0.7}s infinite`,
              pointerEvents: "none",
            }}
          />
        ))}
      <div style={core} aria-hidden="true">
        {!flat && <div style={sheen} />}
        {!flat && <div style={highlight} />}
      </div>
      {showLabel && (
        <span
          style={{
            position: "absolute",
            bottom: -28,
            fontFamily: "var(--font-mono)",
            fontSize: "var(--t-mono)",
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: "var(--text-dim)",
          }}
        >
          {label}
        </span>
      )}
      <span className="sr-only">
        Caden is {state === "idle" ? "present and listening" : state}
      </span>
    </div>
  );
}
