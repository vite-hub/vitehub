import { cn } from "@/lib/utils";

export { default as Badge } from "./Badge.vue";

const variants = {
  default: "bg-muted text-foreground",
  outline: "border border-ui-border-accented text-foreground",
  solid: "bg-primary text-primary-foreground",
  success: "bg-ui-success/10 text-vh-text-success",
  warning: "bg-ui-warning/10 text-vh-text-warning",
  error: "bg-ui-error/10 text-vh-text-error",
  info: "bg-ui-info/10 text-vh-text-info",
};

export type BadgeVariant = keyof typeof variants;

export function badgeVariants({ variant = "default" }: { variant?: BadgeVariant } = {}): string {
  return cn(
    "inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-md px-1.5 text-xs font-medium whitespace-nowrap tabular-nums [&>svg]:pointer-events-none [&>svg]:size-3",
    variants[variant],
  );
}
