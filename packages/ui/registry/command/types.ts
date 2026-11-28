export interface CommandProps {
  query?: string;
  defaultQuery?: string;
}

export interface CommandEmits {
  "update:query": [query: string];
  action: [event: { value: string }];
}

export interface CommandInputProps {
  label?: string;
  placeholder?: string;
}

export interface CommandInputSlots {
  icon?: () => unknown;
}

export interface CommandEmptyProps {
  label?: string;
}

export interface CommandGroupProps {
  heading?: string;
}

export interface CommandItemProps {
  value: string;
  disabled?: boolean;
  shortcut?: string;
}

export interface CommandDialogProps {
  open?: boolean;
  defaultOpen?: boolean;
  title?: string;
  description?: string;
}

export interface CommandDialogEmits {
  "update:open": [open: boolean];
  action: [event: { value: string }];
}

export interface CommandDialogSlots {
  default?: () => unknown;
  trigger?: () => unknown;
}

export interface CommandSlots {
  default?: () => unknown;
}

export interface CommandListSlots {
  default?: () => unknown;
}

export interface CommandEmptySlots {
  default?: () => unknown;
}

export interface CommandGroupSlots {
  default?: () => unknown;
}

export interface CommandItemSlots {
  default?: () => unknown;
}

export interface CommandShortcutSlots {
  default?: () => unknown;
}
