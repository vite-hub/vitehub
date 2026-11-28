export type AlertTone = "neutral" | "success" | "warning" | "error" | "info";
export type AlertVariant = "soft" | "outline";

export interface AlertProps {
  tone?: AlertTone;
  variant?: AlertVariant;
}

export interface AlertSlots {
  default?: () => unknown;
  icon?: () => unknown;
}

export interface AlertCloseProps {
  label?: string;
}

export interface AlertCloseEmits {
  close: [];
}

export interface AlertCloseSlots {
  default?: () => unknown;
}

export interface AlertContentSlots {
  default?: () => unknown;
}

export interface AlertTitleSlots {
  default?: () => unknown;
}

export interface AlertDescriptionSlots {
  default?: () => unknown;
}

export interface AlertActionsSlots {
  default?: () => unknown;
}
