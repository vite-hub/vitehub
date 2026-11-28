import { cn } from "@/lib/utils";

export { default as Button } from "./Button.vue";

const variants = {
  default: "bg-primary text-primary-foreground hover:bg-primary/90",
  destructive: "bg-destructive text-primary-foreground hover:bg-destructive/90",
  outline: "border border-input bg-background hover:bg-accent",
  secondary: "bg-secondary text-secondary-foreground hover:bg-ui-bg-accented",
  ghost: "hover:bg-accent hover:text-accent-foreground",
  link: "h-auto px-0 underline underline-offset-4 decoration-ui-border-accented hover:decoration-current active:scale-100",
};

const sizes = {
  default: "h-8 px-3",
  xs: "h-6 gap-1 px-2 text-xs [&_svg:not([class*=size-])]:size-3.5",
  sm: "h-7 gap-1.5 px-2.5",
  lg: "h-9 px-4",
  icon: "size-8",
  "icon-sm": "size-7",
  "icon-xs": "size-6 [&_svg:not([class*=size-])]:size-3.5",
};

export type ButtonVariant = keyof typeof variants;
export type ButtonSize = keyof typeof sizes;

export function buttonVariants({ variant = "default", size = "default" }: { variant?: ButtonVariant; size?: ButtonSize } = {}): string {
  return cn(
    "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap select-none transition-[color,background-color,scale] duration-150 active:scale-97 motion-reduce:transition-colors motion-reduce:active:scale-100 disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-pending:cursor-progress data-pending:opacity-60 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-4",
    variants[variant],
    sizes[size],
  );
}
