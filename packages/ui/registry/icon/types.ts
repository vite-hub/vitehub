export type IconSize = "xs" | "sm" | "md" | "lg";

export interface IconProps {
  size?: IconSize;
  label?: string;
}

export interface IconSlots {
  default?: () => unknown;
}
