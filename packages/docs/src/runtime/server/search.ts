import { defineHandler } from "nitro/h3"

import type { EventHandler, EventHandlerRequest } from "nitro/h3"
import manifest from "#docs/manifest"
import { docsIndexedPages, docsUnindexedSearchSections } from "../../navigation.ts"
import { docsSearchSections } from "../../markdown.ts"

import { loadDocsDocument } from "../documents.ts"

import type { DocsSearchSection } from "../../types.ts"

/** Every page split by heading, for the search dialog. The build prerenders it. */
async function buildIndex(): Promise<DocsSearchSection[]> {
  const sections: DocsSearchSection[] = []
  for (const page of docsIndexedPages(manifest)) {
    const document = await loadDocsDocument(page.file, page.source, false)
    if (document === null) continue
    const { nodes } = document
    const [entry, ...headings] = docsSearchSections(page.path, page.sourceTitle, nodes)
    sections.push(page.keywords.length ? { ...entry!, keywords: page.keywords } : entry!, ...headings)
  }
  // A page with `seo.index: false` gets one record with its title and description, so search finds it by name
  // and thousands of generated pages do not fill the index with their headings.
  sections.push(...docsUnindexedSearchSections(manifest))
  return sections
}

let indexed: Promise<DocsSearchSection[]> | undefined
const handler: EventHandler<EventHandlerRequest, Promise<DocsSearchSection[]>> = defineHandler(() => {
  if (import.meta.dev) return buildIndex()
  return indexed ??= buildIndex().catch((error) => {
    indexed = undefined
    throw error
  })
})

export default handler
