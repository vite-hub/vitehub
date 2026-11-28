import type { CopyValue } from "./use-copy.ts";

export type CopyButtonVariant = "ghost" | "outline" | "solid";
export type CopyButtonSize = "xs" | "sm" | "md";

export interface CopyButtonProps {
  /** The text to copy, or a function that returns it. */
  value: CopyValue;
  /** The text in the button. Without it, the button shows only its icon and `copyLabel` names it. */
  label?: string;
  /** The name of an icon-only button. */
  copyLabel?: string;
  /** The text in place of `label` for `duration` ms after a copy, and the announcement. */
  copiedLabel?: string;
  /** The announcement when the browser refuses the copy. */
  failedLabel?: string;
  variant?: CopyButtonVariant;
  size?: CopyButtonSize;
  /** How long, in ms, the check shows after a copy. */
  duration?: number;
  /** Call a function `value` when the pointer enters the button or it gets focus, so the click copies text that is already loaded. */
  preload?: boolean;
  disabled?: boolean;
}

export interface CopyButtonEmits {
  copy: [];
  error: [];
}

export interface CopyButtonSlots {
  /** The text in the button, in place of `label`. */
  default?: () => unknown;
  /** The icon before a copy. Defaults to Lucide's `Copy`. */
  icon?: () => unknown;
  /** The icon for `duration` ms after a copy. Defaults to Lucide's `Check`. */
  "copied-icon"?: () => unknown;
}
