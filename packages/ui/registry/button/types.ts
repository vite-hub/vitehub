export type ButtonVariant = "solid" | "outline" | "soft" | "ghost" | "link" | "destructive";
export type ButtonSize = "xs" | "sm" | "md" | "lg";

export interface ButtonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  type?: "button" | "submit" | "reset";
  label?: string;
  loading?: boolean;
  disabled?: boolean;
}

export interface ButtonSlots {
  default?: () => unknown;
  icon?: () => unknown;
}
