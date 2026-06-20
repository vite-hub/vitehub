export default defineAppConfig({
  github: {
    url: "https://github.com/vite-hub/vitehub",
  },
  socials: {
    discord: "https://discord.gg/YTRDsRP3",
  },
  toc: {
    title: "On this page",
  },
  navigation: {
    sub: "aside",
  },
  ui: {
    colors: {
      primary: "neutral",
      neutral: "zinc",
      warning: "amber",
    },
    container: {
      base: "w-full max-w-none mx-0 px-0 sm:px-0 lg:px-0",
    },
    header: {
      defaultVariants: {
        menu: {
          title: "Navigation",
          description: "ViteHub site navigation",
        },
      },
      slots: {
        root: "bg-default border-b border-default h-[44px] sticky top-0 z-50",
        container: "flex items-center justify-between gap-0 h-full max-w-none !ps-5 !pe-4 lg:grid lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]",
        left: "flex items-center gap-2 lg:w-[var(--vh-sidebar-width)] lg:flex-none",
        center: "hidden lg:flex lg:items-center lg:justify-center",
        right: "flex items-center justify-end gap-1.5 lg:flex-1",
        title: "shrink-0 font-semibold text-sm text-highlighted flex items-center gap-2 tracking-normal",
        toggle: "lg:hidden",
      },
    },
    pageAside: {
      slots: {
        root: "hidden overflow-y-auto lg:block lg:max-h-[calc(100vh-var(--ui-header-height))] lg:sticky lg:top-(--ui-header-height) py-0 lg:ms-0 lg:ps-0 lg:pe-0",
        topHeader: "hidden",
        topBody: "bg-default relative pointer-events-auto flex flex-col mx-0 px-0",
        topFooter: "hidden",
      },
    },
    contentNavigation: {
      defaultVariants: {
        variant: "link",
        color: "neutral",
      },
      slots: {
        root: "space-y-0",
        link: "text-sm text-muted transition-colors hover:text-highlighted rounded-none px-4 py-2 data-[active=true]:bg-muted",
        linkLeadingIcon: "size-4 mr-2 text-muted",
        linkTitle: "truncate",
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
        root: "flex flex-col lg:!grid lg:!grid-cols-[var(--vh-sidebar-width)_minmax(0,1fr)] lg:gap-0 px-0",
        left: "lg:!col-span-1 lg:w-[var(--vh-sidebar-width)] lg:shrink-0 lg:border-e lg:border-default",
        center: "lg:!col-span-1 min-w-0",
        right: "order-first lg:order-last lg:!col-span-1 lg:w-[var(--vh-toc-width)] lg:shrink-0",
      },
    },
    pageHeader: {
      slots: {
        root: "relative border-b-0 px-4 pt-4 pb-6 sm:px-8 lg:px-8 xl:px-12 lg:pt-14",
        container: "flex flex-col",
        wrapper: "contents lg:flex lg:items-start lg:justify-between lg:gap-4",
        title: "order-1 text-[28px] leading-[42px] text-pretty font-semibold text-highlighted",
        description: "order-2 text-lg leading-7 text-pretty text-muted",
        links: "order-3 mt-5 flex flex-wrap items-center gap-1.5 lg:mt-0",
      },
    },
    pageBody: {
      base: "mt-0 px-4 pb-24 sm:px-8 lg:px-8 xl:px-12",
    },
    contentSearchButton: {
      defaultVariants: {
        collapsed: false,
        label: "Search",
        variant: "ghost",
        color: "neutral",
        size: "sm",
      },
      slots: {
        base: "w-full justify-start rounded-none border-b border-default px-4 py-3 text-muted hover:text-highlighted",
        trailing: "ms-auto flex items-center gap-0.5",
      },
    } as any,
    contentSearch: {
      defaultVariants: {
        placeholder: "Search",
      },
      slots: {
        modal: "vitehub-content-search-modal w-[calc(100vw-1rem)] !max-w-[640px] !h-auto rounded-sm border border-default shadow-none max-h-[calc(100dvh-1rem)] sm:max-h-[70vh]",
        input: "[&>input]:h-14 [&>input]:text-lg",
      },
    } as any,
    contentToc: {
      defaultVariants: {
        highlightVariant: "circuit",
      },
      slots: {
        root: "sticky top-(--ui-header-height) z-10 bg-default overflow-y-auto max-h-[calc(100vh-var(--ui-header-height))]",
        container: "flex flex-col pt-14 pb-4",
        title: "text-sm font-medium text-muted",
      },
    },
    prose: {
      a: {
        base: "font-medium underline underline-offset-4 text-default hover:text-primary transition-colors",
      },
      callout: {
        slots: {
          base: "rounded-none border border-dashed bg-default",
        },
        variants: {
          color: {
            info: { base: "border-default bg-muted/30", icon: "text-muted" },
            warning: { base: "border-default bg-muted/30", icon: "text-muted" },
            error: { base: "border-default bg-muted/30", icon: "text-muted" },
            success: { base: "border-default bg-muted/30", icon: "text-muted" },
            neutral: { base: "border-s-stone-500/50" },
          },
        },
      },
      h2: {
        slots: {
          base: "relative text-[22px] leading-8 text-highlighted font-semibold mt-6 mb-4 scroll-mt-[calc(48px+var(--ui-header-height))] [&>a]:focus-visible:outline-primary",
          leading: "hidden",
          link: "group",
        },
      },
      h3: {
        slots: {
          base: "relative text-xl leading-7 text-highlighted font-semibold mt-8 mb-3 scroll-mt-[calc(32px+var(--ui-header-height))] [&>a]:focus-visible:outline-primary",
          leading: "hidden",
          link: "group",
        },
      },
      tabs: {
        slots: {
          root: "rounded-none border border-default gap-0 my-5",
          list: "rounded-none border-0 border-b border-default bg-default p-0",
          indicator: "rounded-none bg-default shadow-none border-b border-highlighted",
          trigger: "rounded-none px-4 py-2 text-sm text-muted data-[state=active]:text-highlighted hover:bg-transparent",
        },
      },
      tabsItem: {
        base: "p-0",
      },
      codeGroup: {
        slots: {
          root: "rounded-none border border-default gap-0 my-5",
          list: "rounded-none border-0 border-b border-default bg-default p-0",
          indicator: "rounded-none bg-default shadow-none border-b border-highlighted",
          trigger: "rounded-none px-4 py-2 text-sm text-muted data-[state=active]:text-highlighted hover:bg-transparent",
        },
      },
      pre: {
        slots: {
          root: "relative my-5 group",
          header: "flex items-center gap-1.5 border border-default bg-default border-b-0 relative rounded-none px-4 py-3",
          base: "group font-mono text-sm/6 border border-default bg-muted rounded-none px-4 py-3 whitespace-pre-wrap wrap-break-word overflow-x-auto focus:outline-none",
        },
      },
      steps: {
        base: "vitehub-docs-steps ms-4 border-s border-default ps-8 [counter-reset:step]",
      },
    } as any,
  },
});
