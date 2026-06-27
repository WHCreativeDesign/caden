import React from "react";

export interface PresenceOrbProps {
  /** Diameter in px. Default 180. */
  size?: number;
  /** Behavioural state — drives animation + glow. */
  state?: "idle" | "listening" | "thinking" | "speaking";
  /** Accessible/visible label text. */
  label?: string;
  /** Show the mono label beneath the orb. */
  showLabel?: boolean;
  /** Flat treatment — no glow, sheen, or highlight; very slow morph only. */
  flat?: boolean;
  style?: React.CSSProperties;
}

/**
 * The living embodiment of Caden — a warm morphing blob that breathes, listens,
 * thinks, and steps aside. The signature element of the brand.
 *
 * @startingPoint section="Caden" subtitle="The morphing presence orb" viewport="360x360"
 */
export function PresenceOrb(props: PresenceOrbProps): JSX.Element;
