export const consoleAppConfig = {
  colors: {
    error: "red",
    info: "sky",
    neutral: "zinc",
    primary: "blue",
    success: "emerald",
    warning: "amber",
  },
  icons: {
    arrowDown: "i-lucide-arrow-down",
    arrowLeft: "i-lucide-arrow-left",
    arrowRight: "i-lucide-arrow-right",
    arrowUp: "i-lucide-arrow-up",
    caution: "i-lucide-triangle-alert",
    check: "i-lucide-check",
    chevronDown: "i-lucide-chevron-down",
    chevronLeft: "i-lucide-chevron-left",
    chevronRight: "i-lucide-chevron-right",
    chevronUp: "i-lucide-chevron-up",
    close: "i-lucide-x",
    copy: "i-lucide-copy",
    copyCheck: "i-lucide-check",
    dark: "i-lucide-moon",
    drag: "i-lucide-grip-vertical",
    ellipsis: "i-lucide-ellipsis",
    error: "i-lucide-circle-alert",
    external: "i-lucide-external-link",
    eye: "i-lucide-eye",
    eyeOff: "i-lucide-eye-off",
    file: "i-lucide-file",
    folder: "i-lucide-folder",
    folderOpen: "i-lucide-folder-open",
    hash: "i-lucide-hash",
    info: "i-lucide-info",
    light: "i-lucide-sun",
    loading: "i-lucide-loader-circle",
    menu: "i-lucide-menu",
    minus: "i-lucide-minus",
    panelClose: "i-lucide-panel-left-close",
    panelOpen: "i-lucide-panel-left-open",
    plus: "i-lucide-plus",
    reload: "i-lucide-refresh-cw",
    search: "i-lucide-search",
    stop: "i-lucide-square",
    star: "i-lucide-star",
    success: "i-lucide-circle-check",
    system: "i-lucide-monitor",
    tip: "i-lucide-lightbulb",
    upload: "i-lucide-upload",
    warning: "i-lucide-triangle-alert",
  },
  // Geist's smallest text is 12px, so small badges and key caps use it too.
  badge: {
    variants: {
      size: {
        xs: { base: "px-1.5 py-0 text-xs/4" },
        sm: { base: "px-1.5 py-0.5 text-xs/4" },
      },
    },
  },
  kbd: {
    variants: {
      size: {
        sm: "text-xs",
        md: "text-xs",
      },
    },
  },
  // Buttons are black and white (Geist). Blue is reserved for focus rings, links, selection, and the drop cursor.
  // A press scales the button to 97% (Emil Kowalski); reduced motion keeps it still.
  button: {
    defaultVariants: {
      color: "neutral",
      size: "sm",
    },
    slots: {
      base: "rounded-md font-medium disabled:opacity-50 aria-disabled:opacity-50 transition-[color,background-color,box-shadow,transform] duration-150 ease-out motion-safe:active:not-disabled:scale-[.97] motion-reduce:transition-none",
      leadingIcon: "size-4 opacity-80",
      trailingIcon: "size-3.5 opacity-75",
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
  // Menus open many times a day, so they appear at once (Rauno, Emil Kowalski). Floating surfaces use the 12px Geist
  // menu radius and its layered shadow.
  dropdownMenu: {
    slots: {
      content: "rounded-xl bg-(color:--vitehub-console-floating) shadow-[0_1px_1px_rgb(0_0_0/2%),0_4px_8px_-4px_rgb(0_0_0/4%),0_16px_24px_-8px_rgb(0_0_0/6%)] backdrop-blur-md data-[state=open]:animate-none data-[state=closed]:animate-none",
      label: "text-xs font-medium text-muted",
    },
  },
  empty: {
    slots: {
      root: "gap-3 p-5",
      title: "text-sm font-medium",
      description: "text-xs leading-5",
      actions: "mt-1",
    },
  },
  input: {
    defaultVariants: {
      size: "sm",
    },
    slots: {
      leadingIcon: "size-4 opacity-80",
      trailingIcon: "size-3.5 opacity-75",
    },
  },
  pageCard: {
    slots: {
      container: "gap-0 p-4",
      leading: "mb-3 size-8 rounded-md bg-elevated/60",
      leadingIcon: "size-4 text-muted opacity-80",
      title: "text-sm font-medium",
      description: "mt-1 text-xs/5 text-muted",
    },
  },
  // Geist modal material: 12px radius and a layered shadow.
  modal: {
    variants: {
      fullscreen: {
        false: {
          content: "rounded-xl shadow-[0_1px_1px_rgb(0_0_0/2%),0_8px_16px_-4px_rgb(0_0_0/4%),0_24px_32px_-8px_rgb(0_0_0/6%)]",
        },
      },
    },
  },
  popover: {
    slots: {
      content: "rounded-xl bg-(color:--vitehub-console-floating) shadow-[0_1px_1px_rgb(0_0_0/2%),0_4px_8px_-4px_rgb(0_0_0/4%),0_16px_24px_-8px_rgb(0_0_0/6%)] backdrop-blur-md",
    },
  },
  select: {
    defaultVariants: {
      size: "sm",
    },
    slots: {
      leadingIcon: "size-4 opacity-80",
      trailingIcon: "size-3.5 opacity-75",
      itemLeadingIcon: "size-4 opacity-80",
      itemTrailingIcon: "size-3.5 opacity-75",
      content: "rounded-xl bg-(color:--vitehub-console-floating) shadow-[0_1px_1px_rgb(0_0_0/2%),0_4px_8px_-4px_rgb(0_0_0/4%),0_16px_24px_-8px_rgb(0_0_0/6%)] backdrop-blur-md",
    },
  },
  selectMenu: {
    slots: {
      content: "rounded-xl bg-(color:--vitehub-console-floating) shadow-[0_1px_1px_rgb(0_0_0/2%),0_4px_8px_-4px_rgb(0_0_0/4%),0_16px_24px_-8px_rgb(0_0_0/6%)] backdrop-blur-md",
    },
  },
  table: {
    slots: {
      th: "h-9 px-2.5 py-2 text-xs font-medium text-muted",
      td: "h-9 px-2.5 py-2 text-[13px] tabular-nums text-toned",
    },
  },
  tooltip: {
    slots: {
      content: "bg-(color:--vitehub-console-floating) backdrop-blur-md",
    },
  },
};
