export interface FieldProps {
  invalid?: boolean;
  disabled?: boolean;
}

export interface FieldSlots {
  default?: () => unknown;
}

export interface FieldLabelProps {
  label?: string;
}

export interface FieldLabelSlots {
  default?: () => unknown;
}

export interface FieldDescriptionSlots {
  default?: () => unknown;
}

export interface FieldErrorSlots {
  default?: () => unknown;
}
