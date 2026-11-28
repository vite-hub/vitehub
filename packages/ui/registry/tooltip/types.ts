export type TooltipSide = "top" | "right" | "bottom" | "left";

export interface TooltipProps {
  open?: boolean;
  defaultOpen?: boolean;
  delay?: number;
  label?: string;
}

export interface TooltipEmits {
  "update:open": [open: boolean];
}

export interface TooltipSlots {
  default?: () => unknown;
}

export interface TooltipContentProps {
  side?: TooltipSide;
  sideOffset?: number;
}

export interface TooltipTriggerSlots {
  default?: () => unknown;
}

export interface TooltipContentSlots {
  default?: () => unknown;
}
