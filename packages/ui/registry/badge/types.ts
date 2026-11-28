export type BadgeTone = "neutral" | "success" | "warning" | "error" | "info";
export type BadgeVariant = "soft" | "outline" | "solid";
export type BadgeSize = "sm" | "md";

export interface BadgeProps {
  tone?: BadgeTone;
  variant?: BadgeVariant;
  size?: BadgeSize;
  label?: string;
}

export interface BadgeSlots {
  default?: () => unknown;
  icon?: () => unknown;
}
