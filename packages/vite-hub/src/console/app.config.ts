import { vitehubTheme } from "@vite-hub/ui/theme";

// The Console uses the ViteHub design system. Only the parts that the docs do not have get slots here.
export const consoleAppConfig = {
  ...vitehubTheme,
  // A Console page fills its panel edge to edge: its toolbar, lists, and splitters set their own padding, and a list
  // scrolls inside itself. So the panel body has no padding and no gap. It keeps Nuxt UI's `overflow-y-auto`, so a page
  // that is one long column, such as Usage, scrolls in the body.
  dashboardPanel: {
    slots: {
      body: "min-h-0 gap-0 p-0 sm:gap-0 sm:p-0",
    },
  },
  dashboardNavbar: {
    slots: {
      root: "h-11 px-3 sm:px-4",
      title: "text-sm font-medium",
      icon: "size-4 opacity-80",
      left: "gap-1.5",
      right: "gap-1.5",
    },
  },
  dashboardSearchButton: {
    defaultVariants: {
      size: "sm",
    },
    slots: {
      base: "h-9 rounded-md px-2.5 text-sm",
      leadingIcon: "size-4 opacity-80",
      trailing: "text-xs opacity-75",
    },
  },
  // Body editor. The block handle follows the pointer at once, and the `/` menu, opened from the keyboard, appears
  // without animation (Rauno Freiberg, Emil Kowalski). Item descriptions show the Markdown shortcut on the right.
  editorDragHandle: {
    slots: {
      root: "transition-none",
      handle: "px-0.5 text-dimmed hover:text-highlighted",
    },
  },
  editorSuggestionMenu: {
    defaultVariants: {
      size: "md",
    },
    slots: {
      content: "w-72 max-w-72 rounded-xl ring-0 bg-(--vh-floating) shadow-(--vh-shadow-floating) backdrop-blur-md data-[state=open]:animate-none data-[state=closed]:animate-none",
      viewport: "divide-y-0",
      group: "p-1.5",
      label: "px-2 pt-1.5 pb-1 text-xs font-medium text-muted",
      item: "h-8 items-center rounded-md px-2 text-[13px]",
      itemWrapper: "flex-row items-center justify-between gap-3",
      itemLabel: "truncate",
      itemDescription: "shrink-0 font-mono text-xs text-dimmed",
    },
  },
  editorToolbar: {
    variants: {
      layout: {
        bubble: {
          base: "rounded-lg border-0 bg-(--vh-floating) p-1 shadow-(--vh-shadow-floating) backdrop-blur-md",
        },
      },
    },
  },
};
