import { computed, type ComputedRef } from "vue"
import { useError, useRoute, useRuntimeConfig } from "#imports"
import { useDocsSidebarExpanded } from "./tutorial"
import manifest from "#docs/manifest"
import { docsSectionForPath, docsSidebarCollapses, findDocsPage, normalizeDocsPath } from "#docs/navigation"

import type { DocsAppPage, DocsManifest, DocsPublicConfig, DocsSection } from "@vite-hub/docs"

/**
 * Sections and pages of the site, computed from the content folder at build time. Each page has its `DocsAppPage`
 * fields: navigation, title, description, and layout. The page route returns the rest, such as `seo` and `credits`.
 */
export function useDocsManifest(): DocsManifest<DocsAppPage> {
  return manifest
}

/** The `docs` options of `nuxt.config`, as the app reads them. */
export function useDocsConfig(): DocsPublicConfig {
  return useRuntimeConfig().public.docs
}

/** Whether a path is one of the site pages that `start.links` lists. They open inside the start section. */
export function isDocsStartLink(config: DocsPublicConfig, path: string): boolean {
  const normalized = normalizeDocsPath(path)
  return (config.start?.links ?? []).some(link => link.to !== config.base && normalizeDocsPath(link.to) === normalized)
}

/** The docs page of the current route, or `null` on other pages. */
export function useDocsPage(): ComputedRef<{ page: DocsAppPage, section: DocsSection<DocsAppPage> | null } | null> {
  const route = useRoute()
  return computed(() => findDocsPage(manifest, route.path))
}

/** The section of the current route. A start link page resolves to the start section. */
export function useDocsSection(): ComputedRef<DocsSection<DocsAppPage> | null> {
  const route = useRoute()
  const config = useDocsConfig()
  return computed(() => {
    const section = docsSectionForPath(manifest, route.path)
    if (section || !config.start || !isDocsStartLink(config, route.path)) return section
    return manifest.sections.find(candidate => candidate.id === config.start?.section) ?? null
  })
}

/**
 * Whether the current route renders in the docs shell, whose sidebar carries the site navigation on wide screens. That
 * is the `docs` layout: docs pages get it from the module's middleware, and an app page sets it itself. Any other
 * page, such as a `home` page or an app page under a base of `/`, keeps the site header.
 */
export function useDocsShell(): ComputedRef<boolean> {
  const route = useRoute()
  return computed(() => route.meta.layout === "docs")
}

/**
 * How the current route shows the sidebar on wide screens: `open`, `collapsed` to a strip whose button opens it, or
 * `hidden`. A docs page sets it in its frontmatter and an app page in `definePageMeta({ layout: "docs", sidebar })`.
 * Code panel tutorials start collapsed. Once the reader opens a collapsed sidebar, it stays open on every such page.
 */
export function useDocsSidebar(): ComputedRef<{ state: "open" | "collapsed" | "hidden", collapsible: boolean }> {
  const shell = useDocsShell()
  const found = useDocsPage()
  const route = useRoute()
  const expanded = useDocsSidebarExpanded()
  return computed(() => {
    if (!shell.value || useError().value) return { state: "hidden", collapsible: false }
    const meta = route.meta.sidebar
    const page = found.value?.page
    const setting = meta === false || meta === "collapsed" ? meta : page ? (docsSidebarCollapses(page) ? "collapsed" : page.sidebar) : true
    if (setting === false) return { state: "hidden", collapsible: false }
    if (setting !== "collapsed") return { state: "open", collapsible: false }
    return { state: expanded.value ? "open" : "collapsed", collapsible: true }
  })
}

/**
 * Whether the route shows the sidebar column, open or collapsed. On wide screens that column then carries the brand,
 * search, and the site links, and the site header hides. A page with `sidebar: false` keeps the header.
 */
export function useDocsSidebarShown(): ComputedRef<boolean> {
  const sidebar = useDocsSidebar()
  return computed(() => sidebar.value.state !== "hidden")
}
