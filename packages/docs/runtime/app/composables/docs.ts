import { computed, type ComputedRef } from "vue"
import { useRoute, useRuntimeConfig } from "#imports"
import manifest from "#docs/manifest"
import { docsSectionForPath, findDocsPage, isDocsPath, normalizeDocsPath } from "#docs/navigation"

import type { DocsManifest, DocsPage, DocsPublicConfig, DocsSection } from "@vite-hub/docs"

/** Sections and pages of the site, computed from the content folder at build time. */
export function useDocsManifest(): DocsManifest {
  return manifest
}

/** The `docs` options of `nuxt.config`, as the app reads them. */
export function useDocsConfig(): DocsPublicConfig {
  // SAFETY: the docs module writes this key with the `DocsPublicConfig` shape.
  return useRuntimeConfig().public.docs as DocsPublicConfig
}

/** Whether a path is one of the site pages that `start.links` lists. They open inside the start section. */
export function isDocsStartLink(config: DocsPublicConfig, path: string): boolean {
  const normalized = normalizeDocsPath(path)
  return (config.start?.links ?? []).some(link => link.to !== config.base && normalizeDocsPath(link.to) === normalized)
}

/** The docs page of the current route, or `null` on other pages. */
export function useDocsPage(): ComputedRef<{ page: DocsPage, section: DocsSection | null } | null> {
  const route = useRoute()
  return computed(() => findDocsPage(manifest, route.path))
}

/** The section of the current route. A start link page resolves to the start section. */
export function useDocsSection(): ComputedRef<DocsSection | null> {
  const route = useRoute()
  const config = useDocsConfig()
  return computed(() => {
    const section = docsSectionForPath(manifest, route.path)
    if (section || !config.start || !isDocsStartLink(config, route.path)) return section
    return manifest.sections.find(candidate => candidate.id === config.start?.section) ?? null
  })
}

/** Whether the current route renders in the docs shell: a page under the base, or an app page with the `docs` layout. */
export function useDocsShell(): ComputedRef<boolean> {
  const route = useRoute()
  const config = useDocsConfig()
  return computed(() => {
    const path = normalizeDocsPath(route.path)
    return route.meta.layout === "docs" || isDocsPath(path, config.base)
  })
}
