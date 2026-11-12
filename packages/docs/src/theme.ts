import { vitehubTheme } from "@vite-hub/ui/theme"
import { defu } from "defu"

export { docsThemeScope, type DocsThemeScope } from "../runtime/app/utils/docs-theme.ts"

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

// Nuxt UI tints callout text, code, and links with the callout color, and amber or green text on a 10% tint is below
// 4.5:1. Callouts keep body text, and only the icon carries the status color.
function callout(icon: string) {
  return {
    base: "border-default bg-muted text-default dark:text-default [&>ul]:marker:text-muted [&_code]:text-default dark:[&_code]:text-default [&_code]:border-default [&_a]:text-default [&_a]:hover:text-highlighted [&_a]:hover:border-default [&_a]:hover:[&>code]:border-default [&_a]:hover:[&>code]:text-highlighted",
    icon,
  }
}

// Code groups and tabs are one framed box: the underline tabs of the theme sit on the top rule, and the panel fills the rest.
const framedTabs = "my-5 gap-0 rounded-lg border border-default"

/**
 * The docs design: the ViteHub design system (`vitehubTheme`) plus the slots that only the docs shell has, such as the
 * header with search in the middle, the rail of areas next to a page list, the page grid, the outline, and prose.
 */
export function docsUi(siteName: string): DocsThemeUi {
  return defu({
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
        // The side columns never get narrower than their links, so the search field gives up width instead of covering them.
        container: "flex items-center justify-between gap-4 h-full max-w-none !ps-[1.125rem] !pe-4 lg:grid lg:grid-cols-[minmax(max-content,1fr)_minmax(12rem,24rem)_minmax(max-content,1fr)]",
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
    // Nuxt UI makes a menu icon as tall as the line (16px beside 12px text). Icons near 1.15 times the font size
    // read as part of the label.
    dropdownMenu: {
      slots: {
        item: "items-center",
      },
      variants: {
        size: {
          xs: { itemLeadingIcon: "size-3.5", itemTrailingIcon: "size-3.5" },
          sm: { itemLeadingIcon: "size-3.5", itemTrailingIcon: "size-3.5" },
          md: { itemLeadingIcon: "size-4", itemTrailingIcon: "size-4" },
          lg: { itemLeadingIcon: "size-4", itemTrailingIcon: "size-4" },
          xl: { itemLeadingIcon: "size-4.5", itemTrailingIcon: "size-4.5" },
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
        link: "text-sm text-muted transition-colors hover:text-highlighted px-4 py-2 data-[active=true]:bg-elevated",
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
        title: "min-w-0 flex-[1_1_18rem] text-[2rem] sm:text-[2rem] leading-[1.15] tracking-[-0.015em] text-balance font-semibold text-highlighted",
        description: "mt-2 max-w-[34rem] text-[1.0625rem] leading-[1.7] text-pretty text-muted",
        links: "flex flex-wrap items-center gap-2",
      },
    },
    pageBody: {
      base: "mt-8 px-4 pb-24 sm:px-8",
    },
    pageGrid: {
      base: "grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-2",
    },
    contentSearchButton: {
      defaultVariants: {
        collapsed: false,
        label: "Search",
        variant: "ghost",
        color: "neutral",
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
        modal: "vh-docs-search-modal w-[calc(100vw-1rem)] !max-w-[36rem] !h-auto max-h-[calc(100dvh-1rem)] sm:max-h-[70vh]",
        input: "[&>input]:h-14 [&>input]:text-lg",
      },
    },
    contentToc: {
      defaultVariants: {
        highlightVariant: "circuit",
      },
      slots: {
        root: "sticky top-(--ui-header-height) z-10 overflow-y-auto max-h-[calc(100vh-var(--ui-header-height))] lg:mx-0",
        // Nuxt UI draws a dashed rule under the folded outline on phones. Rules are solid in the design system.
        container: "flex flex-col pt-10 pb-8 border-solid",
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
          base: "rounded-lg",
        },
        variants: {
          color: {
            info: callout("text-info"),
            warning: callout("text-warning"),
            error: callout("text-error"),
            success: callout("text-success"),
          },
        },
      },
      card: {
        slots: {
          base: "rounded-lg",
        },
      },
      h2: {
        slots: {
          // A hairline above each section, as on the comark-ui site.
          base: "relative mt-14 mb-4 border-t border-default pt-5 text-lg/[1.3] tracking-[-0.01em] text-highlighted font-semibold scroll-mt-[calc(1rem+var(--ui-header-height))]",
          leading: "hidden",
          link: "group",
        },
      },
      h3: {
        slots: {
          base: "relative mt-9 mb-2 font-mono text-sm/6 text-highlighted font-medium scroll-mt-[calc(1rem+var(--ui-header-height))]",
          leading: "hidden",
          link: "group",
        },
      },
      // Prose tabs render `UTabs`, so the triggers and the underline come from the theme. Only the frame is added.
      // The theme's list sits 1px into the panel, where the panel's first block would paint over the rule.
      tabs: {
        slots: {
          root: framedTabs,
          list: "mb-0 px-2",
        },
      },
      tabsItem: {
        base: "p-0",
      },
      // Code groups render their own tab list. It copies the underline tabs of the theme.
      codeGroup: {
        slots: {
          root: framedTabs,
          list: "gap-1 border-0 border-b border-default rounded-t-lg bg-transparent px-2 py-0",
          indicator: "inset-y-auto -bottom-px h-px bg-(--ui-text-highlighted) shadow-none",
          trigger: "h-8 px-2.5 py-0 text-muted data-[state=active]:text-highlighted hover:bg-transparent hover:text-highlighted",
        },
      },
      // Inline code wraps with the sentence. As an inline block, a long path pushed the page wider than a phone
      // and moved the punctuation after it to its own line.
      code: {
        base: "inline box-decoration-clone wrap-break-word rounded-md border-0 bg-muted px-[0.35em] py-[0.1em] font-mono text-[0.8125rem]/[1.6] text-highlighted ring ring-inset ring-default",
      },
      pre: {
        slots: {
          root: "relative my-5 group",
          // The copy button sits over the end of the header, so long file names wrap before it.
          header: "flex items-center gap-1.5 border border-default bg-muted border-b-0 relative rounded-t-lg ps-4 pe-12 py-2.5 text-[0.8125rem]",
          filename: "min-w-0 wrap-anywhere",
          base: "group font-mono text-[0.8125rem]/6 border border-default bg-muted rounded-lg [[data-slot=header]+&]:rounded-t-none px-[0.9rem] py-[0.8rem] whitespace-pre-wrap wrap-break-word overflow-x-auto",
          // Touch screens cannot reveal the hover-only copy button, so keep it visible and larger.
          copy: "pointer-coarse:opacity-100 pointer-coarse:size-9 pointer-coarse:justify-center pointer-coarse:top-[5px] pointer-coarse:end-[5px]",
        },
      },
      steps: {
        base: "vh-docs-steps ms-4 border-s border-default ps-8 [counter-reset:step]",
      },
    },
  }, vitehubTheme)
}

/** The part of the theme that only adds keys, so an app with its own `app.vue` gets it in its app config. */
export function docsThemeAdditions(theme: DocsThemeUi): DocsThemeUi {
  const prose = isRecord(theme.prose) ? theme.prose : {}
  return isRecord(prose.codeIcon) ? { prose: { codeIcon: prose.codeIcon } } : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
