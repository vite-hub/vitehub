export type StatusTone = "neutral" | "success" | "warning" | "error" | "info";
export type StatusSize = "sm" | "md";

export interface StatusProps {
  /** The color of the dot. */
  tone?: StatusTone;
  /** The text after the dot. Without it and without children, only the dot renders. */
  label?: string;
  size?: StatusSize;
  /** The label takes the tone's color too, when the label is the status itself, such as "Failed". */
  colored?: boolean;
  /** The dot pulses, for a live or pending status. */
  pulse?: boolean;
}

export interface StatusSlots {
  /** Replaces the default composition: put `StatusIndicator` and `StatusLabel` in it. */
  default?: () => unknown;
}
