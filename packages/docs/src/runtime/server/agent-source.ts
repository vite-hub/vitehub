import { useStorage } from "#imports"

import type { H3Event } from "h3"
import manifest from "#docs/manifest"
import { docsManifestPages, findDocsPage, isDocsPath } from "../../navigation.ts"

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
 * is its `/raw` copy, so every agent path reads the same text.
 */
const source: AgentContentSource = {
  list() {
    const isDocs = (path: string) => isDocsPath(path, manifest.base)
    // Docs pages come first, then pages outside the base, each in URL order. llms.txt groups them in this order.
    const rank = (path: string) => isDocs(path) ? 0 : 1
    return docsManifestPages(manifest)
      // nuxt-agent-discovery lists the home page itself, first.
      .filter(page => page.path !== "/")
      .map(page => ({ route: page.path, title: page.sourceTitle, description: page.description ?? undefined, section: isDocs(page.path) ? "Docs" : "Pages" }))
      .sort((left, right) => rank(left.route) - rank(right.route) || (left.route < right.route ? -1 : left.route > right.route ? 1 : 0))
  },
  async get(route) {
    const found = findDocsPage(manifest, route)
    if (!found) return null
    const markdown = await useStorage("assets:docs-raw").getItem<string>(found.page.path === "/" ? "index.md" : `${found.page.path.slice(1)}.md`)
    return markdown === null ? null : { markdown: String(markdown), title: found.page.sourceTitle, description: found.page.description ?? undefined }
  },
}

export default source
