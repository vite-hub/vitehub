import { normalizeClass } from "vue";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: unknown[]): string {
  return twMerge(normalizeClass(inputs));
}
