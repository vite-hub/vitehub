import { defu } from "defu"

/** Nuxt UI app config of the docs design: color aliases, icons, and slot classes per component. */
export type DocsThemeUi = Record<string, unknown>

/**
 * The `ui` app config of the site. What the app writes in its Nuxt config wins over the design, and the design wins
 * over the rest, such as the green and slate defaults that Nuxt UI adds when the app lists `@nuxt/ui` before this
 * module. `app.config.ts` still wins over all of it at runtime.
 */
export function docsAppConfigUi(design: DocsThemeUi, current: DocsThemeUi | undefined, configured: Array<DocsThemeUi | undefined>): DocsThemeUi {
  return [...configured, design, current].reduce<DocsThemeUi>((merged, layer) => defu(merged, layer ?? {}), {})
}

// The design keeps the docs black, white, and neutral gray. Nuxt UI tints callout text, code, and links with the callout
// color, and amber or green text on the callout background is below 4.5:1 contrast, so every callout uses body colors.
const monochromeCallout = {
  base: [
    "rounded-(--vh-frame-radius) border-default bg-muted text-default dark:text-default [&>ul]:marker:text-muted",
    "[&_code]:text-default dark:[&_code]:text-default [&_code]:border-default",
    "[&_a]:text-default [&_a]:hover:text-default [&_a]:focus-visible:text-default [&_a]:hover:border-default [&_a]:outline-inverted",
    "[&_a]:[&>code]:outline-inverted [&_a]:hover:[&>code]:border-default [&_a]:hover:[&>code]:text-default",
    "[&_a]:focus-visible:[&>code]:border-default [&_a]:focus-visible:[&>code]:text-default",
  ].join(" "),
  icon: "text-muted",
}

/**
 * Slot classes of the docs design, after the comark-ui site: Geist, neutral grays, hairline rings, small radii, a
 * header with search in the middle, and a rail of areas next to a page list.
 */
export function docsUi(siteName: string): DocsThemeUi {
  return {
    // Lucide icons for the color mode control, like the rest of the site.
    icons: {
      light: "i-lucide-sun",
      dark: "i-lucide-moon",
    },
    colors: {
      primary: "neutral",
      neutral: "neutral",
      warning: "amber",
    },
    container: {
      base: "w-full max-w-none mx-0 px-0 sm:px-0 lg:px-0",
    },
    header: {
      defaultVariants: {
        menu: {
          title: "Navigation",
          description: `${siteName} site navigation`,
        },
      },
      slots: {
        root: "vh-grain-surface border-b border-default h-(--ui-header-height) sticky top-0 z-50",
        container: "flex items-center justify-between gap-4 h-full max-w-none !ps-[1.125rem] !pe-4 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)_minmax(0,1fr)]",
        left: "flex min-w-0 items-center gap-8",
        center: "hidden lg:flex lg:w-full lg:items-center",
        right: "flex items-center justify-end gap-1",
        title: "shrink-0 font-semibold text-sm text-highlighted flex items-center gap-2 tracking-normal",
        toggle: "lg:hidden",
      },
    },
    pageAside: {
      slots: {
        root: "hidden h-[calc(100dvh-var(--ui-header-height))] overflow-hidden lg:block lg:sticky lg:top-(--ui-header-height) py-0 lg:ms-0 lg:ps-0 lg:pe-0",
        container: "relative flex h-full min-h-0 flex-col",
        topHeader: "hidden",
        topBody: "relative pointer-events-auto flex h-full min-h-0 flex-col mx-0 px-0",
        topFooter: "hidden",
      },
    },
    commandPalette: {
      slots: {
        item: "items-center",
        input: "[&_.iconify]:size-4 [&_.iconify]:mx-0.5",
      },
      variants: {
        size: {
          md: {
            itemLeadingIcon: "size-4 mx-0.5",
          },
        },
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
        root: "relative border-b-0 px-4 pt-10 pb-2 sm:px-8",
        container: "flex flex-col",
        headline: "mb-2 text-[0.8125rem] font-normal text-dimmed",
        // A row that wraps: the title takes the line, and the page actions follow it or drop below it.
        wrapper: "flex flex-row flex-wrap items-center lg:items-center justify-between gap-x-6 gap-y-3",
        title: "min-w-0 flex-[1_1_18rem] text-[2rem] sm:text-[2rem] leading-[1.15] tracking-[-0.025em] text-balance font-semibold text-highlighted",
        description: "mt-2 max-w-[34rem] text-[1.0625rem] leading-[1.7] text-pretty text-muted",
        links: "flex flex-wrap items-center gap-2",
      },
    },
    pageBody: {
      base: "mt-8 px-4 pb-24 sm:px-8",
    },
    pageGrid: {
      base: "grid-cols-1 gap-px border border-default bg-[var(--ui-border)] sm:grid-cols-2 lg:grid-cols-2",
    },
    pageCard: {
      defaultVariants: {
        variant: "ghost",
      },
      slots: {
        root: "group rounded-none bg-default",
        container: "gap-0 p-4 sm:p-5",
        leading: "mb-3 size-8 items-center justify-center rounded-md border border-default bg-muted",
        leadingIcon: "size-4 text-muted transition-colors group-hover:text-highlighted",
        title: "text-sm font-semibold",
        description: "mt-1 text-sm/6 text-muted",
      },
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
        base: "w-full justify-start rounded-md px-3 py-2 text-muted hover:text-highlighted",
        trailing: "ms-auto flex items-center gap-0.5",
      },
    },
    contentSearch: {
      defaultVariants: {
        placeholder: "Search",
        // A command palette opens and closes at once, without the scale and fade of a modal.
        transition: false,
      },
      slots: {
        modal: "vh-docs-search-modal w-[calc(100vw-1rem)] !max-w-[36rem] !h-auto rounded-(--vh-frame-radius) border border-default shadow-none max-h-[calc(100dvh-1rem)] sm:max-h-[70vh]",
        input: "[&>input]:h-14 [&>input]:text-lg",
      },
    },
    contentToc: {
      defaultVariants: {
        highlightVariant: "circuit",
      },
      slots: {
        root: "sticky top-(--ui-header-height) z-10 overflow-y-auto max-h-[calc(100vh-var(--ui-header-height))] lg:mx-0",
        container: "flex flex-col pt-10 pb-8",
        title: "text-xs font-medium text-highlighted",
        link: "py-1 text-[0.8125rem] text-dimmed hover:text-highlighted data-[active]:text-highlighted",
      },
    },
    prose: {
      codeIcon: {
        js: "i-vscode-icons-file-type-js-official",
        mjs: "i-vscode-icons-file-type-js-official",
        txt: "i-vscode-icons-file-type-text",
      },
      a: {
        base: "font-normal underline underline-offset-[0.2em] decoration-(--ui-border) text-highlighted hover:decoration-current transition-colors",
      },
      callout: {
        slots: {
          base: "rounded-(--vh-frame-radius) border bg-muted",
        },
        variants: {
          color: {
            info: monochromeCallout,
            warning: monochromeCallout,
            error: monochromeCallout,
            success: monochromeCallout,
            neutral: { base: "border-s-stone-500/50" },
          },
        },
      },
      h2: {
        slots: {
          // A hairline above each section, as on the comark-ui site.
          base: "relative mt-14 mb-4 border-t border-default pt-5 text-lg/[1.3] tracking-[-0.01em] text-highlighted font-semibold scroll-mt-[calc(1rem+var(--ui-header-height))] [&>a]:focus-visible:outline-primary",
          leading: "hidden",
          link: "group",
        },
      },
      h3: {
        slots: {
          base: "relative mt-9 mb-2 font-mono text-sm/6 text-highlighted font-medium scroll-mt-[calc(1rem+var(--ui-header-height))] [&>a]:focus-visible:outline-primary",
          leading: "hidden",
          link: "group",
        },
      },
      tabs: {
        slots: {
          // The tabs of the comark-ui site: plain labels with a line under the open one, over a framed panel.
          root: "gap-3 my-6",
          list: "rounded-none border-0 bg-transparent p-0 gap-5 overflow-x-auto",
          indicator: "rounded-none bg-transparent shadow-none border-b border-(--ui-text-highlighted)",
          trigger: "rounded-none px-0 py-2 text-sm font-medium text-dimmed data-[state=active]:text-highlighted hover:bg-transparent hover:text-highlighted",
        },
      },
      tabsItem: {
        base: "p-0 rounded-(--vh-frame-radius) ring ring-default overflow-hidden",
      },
      codeGroup: {
        slots: {
          // The tabs of the comark-ui site: plain labels with a line under the open one, over a framed panel.
          root: "gap-3 my-6",
          list: "rounded-none border-0 bg-transparent p-0 gap-5 overflow-x-auto",
          indicator: "rounded-none bg-transparent shadow-none border-b border-(--ui-text-highlighted)",
          trigger: "rounded-none px-0 py-2 text-sm font-medium text-dimmed data-[state=active]:text-highlighted hover:bg-transparent hover:text-highlighted",
        },
      },
      // Inline code wraps with the sentence. As an inline block, a long path pushed the page wider than a phone
      // and moved the punctuation after it to its own line.
      code: {
        base: "inline box-decoration-clone wrap-break-word rounded-[4px] border-0 bg-muted px-[0.35em] py-[0.1em] font-mono text-[0.8125rem]/[1.6] text-highlighted ring ring-inset ring-default",
      },
      pre: {
        slots: {
          root: "relative my-5 group",
          // The copy button sits over the end of the header, so long file names wrap before it.
          header: "flex items-center gap-1.5 border border-default bg-default border-b-0 relative rounded-t-(--vh-frame-radius) ps-4 pe-12 py-2.5 text-[0.8125rem]",
          filename: "min-w-0 wrap-anywhere",
          base: "group font-mono text-[0.8125rem]/6 border border-default bg-muted rounded-(--vh-frame-radius) [[data-slot=header]+&]:rounded-t-none px-[0.9rem] py-[0.8rem] whitespace-pre-wrap wrap-break-word overflow-x-auto focus:outline-none",
          // Touch screens cannot reveal the hover-only copy button, so keep it visible and larger.
          copy: "pointer-coarse:opacity-100 pointer-coarse:size-9 pointer-coarse:justify-center pointer-coarse:top-[5px] pointer-coarse:end-[5px]",
        },
      },
      steps: {
        base: "vh-docs-steps ms-4 border-s border-default ps-8 [counter-reset:step]",
      },
    },
  }
}
