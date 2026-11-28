import type { Toaster } from "@ui-sdk/vue/toast";

export interface ToasterProps {
  toaster?: Toaster<unknown>;
  side?: "top" | "bottom";
  closeLabel?: string;
}

export interface ToasterSlots {
  default?: () => unknown;
}
