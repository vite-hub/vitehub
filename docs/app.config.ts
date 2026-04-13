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
    titleTemplate: "%s · ViteHub",
  },
  header: {
    title: "ViteHub",
    logo: {
      light: "/favicon.svg",
      dark: "/favicon.svg",
      alt: "ViteHub",
      favicon: "/favicon.svg",
      class: "h-8 w-auto",
    },
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
