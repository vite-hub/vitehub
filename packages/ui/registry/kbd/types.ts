export type KbdSize = "sm" | "md";

export interface KbdProps {
  size?: KbdSize;
  label?: string;
}

export interface KbdSlots {
  default?: () => unknown;
}

export interface KbdGroupSlots {
  default?: () => unknown;
}
