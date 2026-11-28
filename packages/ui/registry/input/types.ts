export type InputSize = "xs" | "sm" | "md" | "lg";

export interface InputProps {
  modelValue?: string;
  defaultValue?: string;
  size?: InputSize;
  invalid?: boolean;
  disabled?: boolean;
}
