export type SheetSide = "top" | "right" | "bottom" | "left";

export interface SheetProps {
  open?: boolean;
  defaultOpen?: boolean;
  side?: SheetSide;
}

export interface SheetEmits {
  "update:open": [open: boolean];
}

export interface SheetSlots {
  default?: () => unknown;
}

export interface SheetContentProps {
  closeLabel?: string;
}

export interface SheetContentSlots {
  default?: () => unknown;
  close?: () => unknown;
}

export interface SheetTriggerSlots {
  default?: () => unknown;
}

export interface SheetCloseSlots {
  default?: () => unknown;
}

export interface SheetTitleSlots {
  default?: () => unknown;
}

export interface SheetDescriptionSlots {
  default?: () => unknown;
}

export interface SheetHeaderSlots {
  default?: () => unknown;
}

export interface SheetFooterSlots {
  default?: () => unknown;
}
