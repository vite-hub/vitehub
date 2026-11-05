import { defineEventHandler, useStorage } from "#imports"

import type { EventHandler, EventHandlerRequest } from "h3"
import manifest from "#docs/manifest"
import parser from "#docs/parser"
import { docsManifestPages } from "../../navigation.ts"
import { createDocsParser, docsSearchSections } from "../../markdown.ts"

import type { DocsSearchSection } from "../../types.ts"

const parse = createDocsParser(parser)

/** Every page split by heading, for the search dialog. The build prerenders it. */
const handler: EventHandler<EventHandlerRequest, Promise<DocsSearchSection[]>> = defineEventHandler(async (): Promise<DocsSearchSection[]> => {
  const storage = useStorage("assets:docs")
  const sections: DocsSearchSection[] = []
  for (const page of docsManifestPages(manifest)) {
    const source = await storage.getItem<string>(page.file)
    if (source === null) continue
    const { nodes } = await parse(String(source))
    sections.push(...docsSearchSections(page.path, page.sourceTitle, nodes))
  }
  return sections
})

export default handler
