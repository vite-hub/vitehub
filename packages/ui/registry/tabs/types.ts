export interface TabsProps {
  modelValue?: string;
  defaultValue?: string;
  orientation?: "horizontal" | "vertical";
}

export interface TabsEmits {
  "update:modelValue": [value: string];
}

export interface TabsTriggerProps {
  value: string;
  disabled?: boolean;
}

export interface TabsContentProps {
  value: string;
}

export interface TabsSlots {
  default?: () => unknown;
}

export interface TabsListSlots {
  default?: () => unknown;
}

export interface TabsTriggerSlots {
  default?: () => unknown;
}

export interface TabsContentSlots {
  default?: () => unknown;
}
