export default defineAppConfig({
  github: {
    url: "https://github.com/vite-hub/vitehub",
  },
  docus: {
    locale: "en",
    colorMode: "",
  },
  navigation: {
    sub: "header",
  },
  seo: {
    siteName: "ViteHub",
    title: "ViteHub",
    description: "Server primitives for Vite.",
  },
  ui: {
    colors: {
      primary: "yellow",
      neutral: "stone",
      warning: "amber",
      important: "violet",
    },
    contentNavigation: {
      defaultVariants: {
        variant: "link",
      },
      slots: {
        root: "space-y-6",
        link: "border-l border-default pl-4 text-sm text-toned transition-colors hover:text-highlighted",
        linkLeadingIcon: "size-4 mr-2",
        linkLabel: "truncate",
        linkTrailing: "hidden",
      },
    },
    pageAside: {
      slots: {
        root: "hidden overflow-y-auto lg:block lg:max-h-[calc(100vh-var(--vitehub-docs-sticky-offset))] lg:sticky lg:top-(--vitehub-docs-sticky-offset) py-8 lg:ps-4 lg:-ms-4 lg:pe-6.5",
      },
    },
    contentToc: {
      slots: {
        root: "sticky top-(--vitehub-docs-sticky-offset) z-10 bg-default/75 lg:bg-[initial] backdrop-blur -mx-4 px-4 sm:px-6 sm:-mx-6 lg:ms-0 overflow-y-auto max-h-[calc(100vh-var(--vitehub-docs-sticky-offset))]",
      },
    },
    pageLinks: {
      slots: {
        linkLeadingIcon: "size-4",
        linkLabelExternalIcon: "size-2.5",
      },
    },
    prose: {
      tabs: {
        slots: {
          root: "rounded border border-default gap-0",
        },
      },
      tabsItem: {
        base: "p-4",
      },
    },
  },
  toc: {
    title: "On this page",
    bottom: {
      links: [],
    },
  },
});
