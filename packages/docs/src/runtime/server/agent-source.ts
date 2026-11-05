import { useRuntimeConfig, useStorage } from "#imports"

import type { H3Event } from "h3"
import manifest from "#docs/manifest"
import { docsAppPath, docsManifestPages, docsRawFile, docsRawSectionLinks, findDocsPage, isDocsPath } from "../../navigation.ts"

import type { DocsPublicConfig } from "../../nuxt.ts"

interface AgentPageEntry {
  route: string
  title?: string
  description?: string
  section?: string
}

interface AgentContentSource {
  list: () => AgentPageEntry[]
  get: (route: string, event?: H3Event) => Promise<{ markdown: string, title?: string, description?: string } | null>
}

/**
 * The pages that nuxt-agent-discovery lists in `sitemap.md` and `llms.txt` and joins into `llms-full.txt`. Each page
 * is its `/raw` copy, so every agent path reads the same text. `llms-full.txt` already holds every page, so the copy
 * leaves out the section links at the end.
 */
const source: AgentContentSource = {
  list() {
    const { appBase } = useRuntimeConfig().public.docs as DocsPublicConfig
    const isDocs = (path: string) => isDocsPath(path, manifest.base)
    // Docs pages come first, then pages outside the base, each in URL order. llms.txt groups them in this order.
    const rank = (path: string) => isDocs(path) ? 0 : 1
    return docsManifestPages(manifest)
      // nuxt-agent-discovery lists the home page itself, first.
      .filter(page => page.path !== "/")
      .map(page => ({ route: page.path, title: page.sourceTitle, description: page.description ?? undefined, section: isDocs(page.path) ? "Docs" : "Pages" }))
      .sort((left, right) => rank(left.route) - rank(right.route) || (left.route < right.route ? -1 : left.route > right.route ? 1 : 0))
      .map(page => ({ ...page, route: docsAppPath(page.route, appBase) }))
  },
  async get(route, event) {
    const { appBase, site } = useRuntimeConfig(event).public.docs as DocsPublicConfig
    const prefix = appBase.replace(/\/+$/, "")
    const path = prefix && (route === prefix || route.startsWith(`${prefix}/`)) ? route.slice(prefix.length) || "/" : route
    const found = findDocsPage(manifest, path)
    if (!found) return null
    const markdown = await useStorage("assets:docs-raw").getItem<string>(docsRawFile(found.page.path))
    if (markdown === null) return null
    const links = docsRawSectionLinks(manifest, found.page.path, `${site.url}${prefix}`)
    const text = String(markdown)
    return { markdown: text.endsWith(links) ? text.slice(0, -links.length) : text, title: found.page.sourceTitle, description: found.page.description ?? undefined }
  },
}

export default source
