export default defineAppConfig({
  github: {
    url: "https://github.com/vite-hub/vitehub",
  },
  navigation: {
    sub: "aside",
  },
  ui: {
    colors: {
      primary: "yellow",
      neutral: "stone",
      warning: "amber",
    },
    contentNavigation: {
      defaultVariants: {
        variant: "link",
      },
      slots: {
        root: "space-y-1",
        link: "text-sm text-muted transition-colors hover:text-highlighted",
        linkLeadingIcon: "size-4 mr-2",
        linkLabel: "truncate",
        linkTrailing: "hidden",
      },
    },
    pageLinks: {
      slots: {
        linkLeadingIcon: "size-4",
        linkLabelExternalIcon: "size-2.5",
      },
    },
    page: {
      slots: {
        root: "flex flex-col lg:flex-row lg:gap-8 px-4 sm:px-6 lg:px-8 xl:px-12",
        center: "flex-1 min-w-0 max-w-[var(--vh-content-width,860px)] mx-auto",
        right: "hidden xl:block w-[var(--vh-toc-width,268px)] shrink-0",
      },
    },
    pageBody: {
      base: "mt-8 pb-24 space-y-12",
    },
    contentToc: {
      slots: {
        header: "text-sm font-semibold mb-3 text-highlighted",
        links: "space-y-1",
        link: "block py-1.5 text-sm text-muted transition-colors hover:text-default",
        linkActive: "text-highlighted",
      },
    },
    prose: {
      a: {
        base: "font-medium underline underline-offset-4 text-default hover:text-primary transition-colors",
      },
      callout: {
        slots: {
          base: "border-0 border-s-2 border-dashed rounded-none bg-muted",
        },
        variants: {
          color: {
            info: { base: "border-s-blue-500/50", icon: "text-blue-500" },
            warning: { base: "border-s-amber-500/50", icon: "text-amber-500" },
            error: { base: "border-s-red-500/50", icon: "text-red-500" },
            success: { base: "border-s-green-500/50", icon: "text-green-500" },
            neutral: { base: "border-s-stone-500/50" },
          },
        },
      },
      tabs: {
        slots: {
          root: "rounded-none border border-default gap-0",
        },
      },
      tabsItem: {
        base: "p-4",
      },
    },
  },
});
