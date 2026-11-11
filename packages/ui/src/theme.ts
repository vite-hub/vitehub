/**
 * The ViteHub design system as Nuxt UI app config: Lucide icons, black and white actions, Geist radii, underline tabs,
 * and the layered floating surfaces. Pair it with `@vite-hub/ui/theme.css`, which holds the tokens and the one focus
 * rule. An app passes it as `appConfig.ui` and merges its own slots over it with `defu`.
 */
export const vitehubTheme = {
  colors: {
    error: "red",
    info: "sky",
    neutral: "neutral",
    primary: "neutral",
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
    chevronDoubleLeft: "i-lucide-chevrons-left",
    chevronDoubleRight: "i-lucide-chevrons-right",
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
    external: "i-lucide-arrow-up-right",
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
  // A compact notice inside a page or a panel: 13px title, 12px text, and full contrast instead of Nuxt UI's 90%.
  alert: {
    defaultVariants: {
      color: "neutral",
      variant: "subtle",
    },
    slots: {
      root: "rounded-lg p-3 gap-2",
      title: "text-[13px] font-medium",
      description: "text-xs leading-5 opacity-100",
      icon: "size-4 mt-0.5",
    },
  },
  // Geist's smallest text is 12px, so small badges and key caps use it too.
  badge: {
    defaultVariants: {
      color: "neutral",
      variant: "subtle",
    },
    slots: {
      base: "font-medium",
    },
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
  // Buttons are black and white. A press scales the button to 97%; reduced motion keeps it still.
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
    // A ghost button that toggles something, such as a filter or a view, shows that it is on with a filled background.
    compoundVariants: [{ variant: "ghost", class: "aria-pressed:bg-elevated aria-pressed:text-highlighted" }],
  },
  card: {
    slots: {
      root: "rounded-lg",
      header: "px-4 py-3 sm:px-4",
      body: "p-4 sm:p-4",
      footer: "px-4 py-3 sm:px-4",
    },
  },
  // Menus open many times a day, so they appear at once. Floating surfaces use the 12px Geist radius and its layered shadow.
  dropdownMenu: {
    slots: {
      content: "rounded-xl ring-0 bg-(--vh-floating) shadow-(--vh-shadow-floating) backdrop-blur-md data-[state=open]:animate-none data-[state=closed]:animate-none",
      label: "text-xs font-medium text-muted",
      itemDescription: "text-clip whitespace-normal",
    },
  },
  contextMenu: {
    slots: {
      content: "rounded-xl ring-0 bg-(--vh-floating) shadow-(--vh-shadow-floating) backdrop-blur-md data-[state=open]:animate-none data-[state=closed]:animate-none",
      label: "text-xs font-medium text-muted",
      itemDescription: "text-clip whitespace-normal",
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
  // Text fields show focus on their own frame: theme.css turns the ring blue (red when the field has an error), and here
  // the frame of a framed field gets 2px wide. A field without a frame shows focus with its caret. Every field is 14px,
  // and 16px on touch screens so that iOS does not zoom.
  input: {
    defaultVariants: {
      size: "sm",
    },
    compoundVariants: [
      { variant: ["outline", "subtle"], class: "focus-visible:ring-2" },
      // Nuxt UI shrinks small fields to 12px from 768px up. Fields stay 14px, the size of the text beside them.
      { fixed: false, size: "sm", class: "md:text-sm/4" },
    ],
    slots: {
      base: "pointer-coarse:text-base",
      leadingIcon: "size-4 opacity-80",
      trailingIcon: "size-3.5 opacity-75",
    },
  },
  inputMenu: {
    defaultVariants: {
      size: "sm",
    },
    compoundVariants: [
      { variant: ["outline", "subtle"], class: "focus-visible:ring-2" },
      // Nuxt UI shrinks small fields to 12px from 768px up. Fields stay 14px, the size of the text beside them.
      { fixed: false, size: "sm", class: "md:text-sm/4" },
    ],
    slots: {
      base: "pointer-coarse:text-base",
      content: "rounded-xl ring-0 bg-(--vh-floating) shadow-(--vh-shadow-floating) backdrop-blur-md",
    },
  },
  inputNumber: {
    defaultVariants: {
      size: "sm",
    },
    compoundVariants: [
      { variant: ["outline", "subtle"], class: "focus-visible:ring-2" },
      // Nuxt UI shrinks small fields to 12px from 768px up. Fields stay 14px, the size of the text beside them.
      { fixed: false, size: "sm", class: "md:text-sm/4" },
    ],
    slots: {
      base: "pointer-coarse:text-base",
    },
  },
  inputTags: {
    defaultVariants: {
      size: "sm",
    },
    compoundVariants: [
      { variant: ["outline", "subtle"], class: { root: "has-focus-visible:ring-2" } },
      { fixed: false, size: "sm", class: { root: "md:text-sm/4" } },
    ],
    slots: {
      root: "pointer-coarse:text-base",
    },
  },
  // Dialogs: 12px radius and a layered shadow. The top stays in place, so content that grows below a field moves
  // nothing above it.
  modal: {
    variants: {
      // Nuxt UI sets the backdrop color in this variant, so it goes here to win over Nuxt UI's gray wash.
      overlay: {
        true: {
          overlay: "bg-black/40 dark:bg-black/60",
        },
      },
      fullscreen: {
        false: {
          content: "max-w-md rounded-xl ring-0 shadow-(--vh-shadow-dialog)",
        },
      },
    },
  },
  pageCard: {
    slots: {
      root: "rounded-lg",
      container: "gap-0 p-4 sm:p-4",
      leading: "mb-3 size-8 justify-center rounded-md bg-elevated/60",
      leadingIcon: "size-4 text-muted opacity-80",
      title: "text-sm font-medium",
      description: "mt-1 text-xs/5 text-muted",
    },
  },
  popover: {
    slots: {
      content: "rounded-xl ring-0 bg-(--vh-floating) shadow-(--vh-shadow-floating) backdrop-blur-md",
    },
  },
  select: {
    defaultVariants: {
      size: "sm",
    },
    compoundVariants: [
      { variant: ["outline", "subtle"], class: "focus-visible:ring-2" },
      // Nuxt UI shrinks small fields to 12px from 768px up. Fields stay 14px, the size of the text beside them.
      { fixed: false, size: "sm", class: "md:text-sm/4" },
    ],
    slots: {
      base: "pointer-coarse:text-base",
      leadingIcon: "size-4 opacity-80",
      trailingIcon: "size-3.5 opacity-75",
      itemLeadingIcon: "size-4 opacity-80",
      itemTrailingIcon: "size-3.5 opacity-75",
      content: "rounded-xl ring-0 bg-(--vh-floating) shadow-(--vh-shadow-floating) backdrop-blur-md",
    },
  },
  selectMenu: {
    defaultVariants: {
      size: "sm",
    },
    compoundVariants: [
      { variant: ["outline", "subtle"], class: "focus-visible:ring-2" },
      // Nuxt UI shrinks small fields to 12px from 768px up. Fields stay 14px, the size of the text beside them.
      { fixed: false, size: "sm", class: "md:text-sm/4" },
    ],
    slots: {
      base: "pointer-coarse:text-base",
      content: "rounded-xl ring-0 bg-(--vh-floating) shadow-(--vh-shadow-floating) backdrop-blur-md",
    },
  },
  table: {
    slots: {
      th: "h-9 px-2.5 py-2 text-xs font-medium text-muted",
      td: "h-9 px-2.5 py-2 text-[13px] tabular-nums text-toned",
    },
  },
  // Tabs are an underline under the active label, as on vitehub.dev and in Vercel's dashboard, not a segmented pill.
  // The label keeps its weight, so switching moves nothing.
  tabs: {
    defaultVariants: {
      color: "neutral",
      size: "sm",
      variant: "link",
    },
    slots: {
      list: "gap-1",
      trigger: "data-[state=inactive]:text-muted data-[state=active]:text-highlighted hover:data-[state=inactive]:not-disabled:text-highlighted",
      indicator: "bg-(--ui-text-highlighted)",
    },
    variants: {
      size: {
        sm: { trigger: "h-8 px-2.5 py-0 text-sm gap-1.5", leadingIcon: "size-4" },
        md: { trigger: "h-9 px-3 py-0 text-sm gap-1.5", leadingIcon: "size-4" },
      },
    },
  },
  textarea: {
    defaultVariants: {
      size: "sm",
    },
    compoundVariants: [{ variant: ["outline", "subtle"], class: "focus-visible:ring-2" }],
    slots: {
      base: "pointer-coarse:text-base",
    },
  },
  toast: {
    slots: {
      root: "rounded-xl ring-0 shadow-(--vh-shadow-floating)",
    },
  },
  tooltip: {
    slots: {
      content: "rounded-md ring-0 bg-(--vh-floating) shadow-(--vh-shadow-floating) backdrop-blur-md",
    },
  },
};

export type ViteHubTheme = typeof vitehubTheme;
