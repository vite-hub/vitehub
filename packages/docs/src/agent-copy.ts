import { docsManifestPages, docsRawSectionLinks } from "./navigation.ts"
import { toRawMarkdown } from "./raw.ts"

import type { DocsManifest, DocsPage } from "./types.ts"

/** The agent copy of a page: the Markdown, and the links of its section that only `/raw/<page>.md` ends with. */
export interface DocsMarkdownCopy {
  markdown: string
  footer: string
}

/**
 * The copy of a page that agents read at `/raw/<page>.md`: the source as plain Markdown with absolute links, then the
 * links of its section. `siteUrl` is the public origin with the app base, such as `https://docs.example.com/portal`.
 */
export function docsAgentCopy(manifest: DocsManifest, page: DocsPage, source: string, siteUrl: string): DocsMarkdownCopy {
  return {
    markdown: toRawMarkdown(source, { siteUrl, pagePath: page.path }),
    footer: docsRawSectionLinks(manifest, page.path, siteUrl),
  }
}

/** The Content Source of a page, named like `createDocsContent()` names it: `docs_<index>` for the server asset `docs-<index>`. */
export function docsContentSource(page: Pick<DocsPage, "source">): string {
  return `docs_${page.source ? page.source.slice("docs-".length) : 0}`
}

/** The pages of each Content Source of the docs, `docs_<index>`, by their file in the Source. */
export function docsAgentPages(manifest: DocsManifest): Map<string, Map<string, DocsPage>> {
  const sources = new Map<string, Map<string, DocsPage>>()
  for (const page of docsManifestPages(manifest)) {
    const name = docsContentSource(page)
    const pages = sources.get(name) ?? new Map<string, DocsPage>()
    pages.set(page.file, page)
    sources.set(name, pages)
  }
  return sources
}
