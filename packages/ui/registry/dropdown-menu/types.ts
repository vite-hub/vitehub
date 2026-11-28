export type DropdownMenuSide = "top" | "right" | "bottom" | "left";
export type DropdownMenuAlign = "start" | "center" | "end";

export interface DropdownMenuProps {
  open?: boolean;
  defaultOpen?: boolean;
}

export interface DropdownMenuEmits {
  "update:open": [open: boolean];
}

export interface DropdownMenuContentProps {
  side?: DropdownMenuSide;
  align?: DropdownMenuAlign;
  sideOffset?: number;
}

export interface DropdownMenuItemProps {
  value?: string;
  destructive?: boolean;
  inset?: boolean;
  disabled?: boolean;
}

export interface DropdownMenuCheckboxItemProps {
  value: string;
  checked?: boolean;
  defaultChecked?: boolean;
  disabled?: boolean;
}

export interface DropdownMenuCheckboxItemEmits {
  "update:checked": [checked: boolean];
}

export interface DropdownMenuRadioGroupProps {
  modelValue?: string;
  defaultValue?: string;
}

export interface DropdownMenuRadioGroupEmits {
  "update:modelValue": [value: string];
}

export interface DropdownMenuRadioItemProps {
  value: string;
  disabled?: boolean;
}

export interface DropdownMenuGroupProps {
  label?: string;
}

export interface DropdownMenuLabelProps {
  inset?: boolean;
}

export interface DropdownMenuSubProps {
  open?: boolean;
  defaultOpen?: boolean;
}

export interface DropdownMenuSubEmits {
  "update:open": [open: boolean];
}

export interface DropdownMenuSubTriggerProps {
  inset?: boolean;
  disabled?: boolean;
}

export interface DropdownMenuSlots {
  default?: () => unknown;
}

export interface DropdownMenuCheckboxItemSlots {
  default?: () => unknown;
}

export interface DropdownMenuContentSlots {
  default?: () => unknown;
}

export interface DropdownMenuGroupSlots {
  default?: () => unknown;
}

export interface DropdownMenuItemSlots {
  default?: () => unknown;
}

export interface DropdownMenuLabelSlots {
  default?: () => unknown;
}

export interface DropdownMenuRadioGroupSlots {
  default?: () => unknown;
}

export interface DropdownMenuRadioItemSlots {
  default?: () => unknown;
}

export interface DropdownMenuShortcutSlots {
  default?: () => unknown;
}

export interface DropdownMenuSubSlots {
  default?: () => unknown;
}

export interface DropdownMenuSubContentSlots {
  default?: () => unknown;
}

export interface DropdownMenuSubTriggerSlots {
  default?: () => unknown;
}

export interface DropdownMenuTriggerSlots {
  default?: () => unknown;
}
