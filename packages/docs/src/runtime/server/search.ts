import { defineEventHandler } from "#imports"

import type { EventHandler, EventHandlerRequest } from "h3"
import manifest from "#docs/manifest"
import { docsManifestPages } from "../../navigation.ts"
import { docsSearchSections } from "../../markdown.ts"

import { loadDocsDocument } from "../documents.ts"

import type { DocsSearchSection } from "../../types.ts"


/** Every page split by heading, for the search dialog. The build prerenders it. */
async function buildIndex(): Promise<DocsSearchSection[]> {
  const sections: DocsSearchSection[] = []
  for (const page of docsManifestPages(manifest)) {
    const document = await loadDocsDocument(page.file, false)
    if (document === null) continue
    const { nodes } = document
    sections.push(...docsSearchSections(page.path, page.sourceTitle, nodes))
  }
  return sections
}

let indexed: Promise<DocsSearchSection[]> | undefined
const handler: EventHandler<EventHandlerRequest, Promise<DocsSearchSection[]>> = defineEventHandler(() => {
  if (import.meta.dev) return buildIndex()
  return indexed ??= buildIndex().catch((error) => {
    indexed = undefined
    throw error
  })
})

export default handler
