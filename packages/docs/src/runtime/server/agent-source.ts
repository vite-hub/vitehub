import { useRuntimeConfig } from "nitro/runtime-config"

import manifest from "#docs/manifest"
import { readDocsFile } from "../files.ts"
import { docsAppPath, docsIndexedPages, docsRawFile, docsRawSectionLinksMarker, findDocsPage, isDocsPath } from "../../navigation.ts"

import type { DocsPublicConfig } from "../../nuxt.ts"

interface AgentPageEntry {
  route: string
  title?: string
  description?: string
  section?: string
}

interface AgentContentSource {
  list: () => AgentPageEntry[]
  get: (route: string) => Promise<{ markdown: string, title?: string, description?: string } | null>
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
    // A page with `seo.index: false` keeps its raw copy, but llms.txt does not list it.
    return docsIndexedPages(manifest)
      // nuxt-agent-discovery lists the home page itself, first.
      .filter(page => page.path !== "/")
      .map(page => ({ route: page.path, title: page.sourceTitle, description: page.description ?? undefined, section: isDocs(page.path) ? "Docs" : "Pages" }))
      .sort((left, right) => rank(left.route) - rank(right.route) || (left.route < right.route ? -1 : left.route > right.route ? 1 : 0))
      .map(page => ({ ...page, route: docsAppPath(page.route, appBase) }))
  },
  async get(route) {
    const { appBase } = useRuntimeConfig().public.docs as DocsPublicConfig
    const prefix = appBase.replace(/\/+$/, "")
    const path = prefix && (route === prefix || route.startsWith(`${prefix}/`)) ? route.slice(prefix.length) || "/" : route
    const found = findDocsPage(manifest, path)
    if (!found) return null
    const markdown = await readDocsFile("docs-raw", docsRawFile(found.page.path))
    if (markdown === null) return null
    const footerIndex = markdown.lastIndexOf(docsRawSectionLinksMarker)
    return { markdown: footerIndex < 0 ? markdown : markdown.slice(0, footerIndex), title: found.page.sourceTitle, description: found.page.description ?? undefined }
  },
}

export default source
