export interface DialogProps {
  open?: boolean;
  defaultOpen?: boolean;
}

export interface DialogEmits {
  "update:open": [open: boolean];
}

export interface DialogSlots {
  default?: () => unknown;
}

export interface DialogContentProps {
  closeLabel?: string;
}

export interface DialogContentSlots {
  default?: () => unknown;
  close?: () => unknown;
}

export interface DialogTriggerSlots {
  default?: () => unknown;
}

export interface DialogHeaderSlots {
  default?: () => unknown;
}

export interface DialogFooterSlots {
  default?: () => unknown;
}

export interface DialogTitleSlots {
  default?: () => unknown;
}

export interface DialogDescriptionSlots {
  default?: () => unknown;
}

export interface DialogCloseSlots {
  default?: () => unknown;
}
