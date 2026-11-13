import { defineContent } from "@vite-hub/content"
import manifest from "#docs/manifest"
import { docsDocumentOf, docsMarkdown } from "../markdown.ts"
import { docsManifestPages } from "../navigation.ts"
import { docsParserOptions } from "./documents.ts"
import { readDocsFile } from "./files.ts"

import type { ContentRuntime } from "@vite-hub/content"
import type { DocsDocument } from "../markdown.ts"
import type { DocsPage } from "../types.ts"

type ContentSource = Extract<NonNullable<Parameters<typeof defineContent>[0]>["sources"], object>[string]

/** The Content Source of a page, named like `createDocsContent()` names it: `docs_<index>` for the server asset `docs-<index>`. */
const sourceOf = (page: Pick<DocsPage, "source">) => `docs_${page.source ? page.source.slice("docs-".length) : 0}`

/** One docs folder as a Content Source, from the production bundle or development server assets. */
function bundledPages(base: string): ContentSource {
  const read = (key: string) => readDocsFile(base, key)
  return {
    keys: async () => docsManifestPages(manifest).filter(page => (page.source ?? "docs") === base).map(page => page.file),
    getItem: async (key: string) => await read(key) ?? "",
    getItemRaw: read,
  }
}

let content: ContentRuntime | undefined

/** The docs pages as Content, parsed with the site's parser. The first page read creates it. */
function docsContent(): ContentRuntime {
  const assets = new Map(docsManifestPages(manifest).map(page => [sourceOf(page), page.source ?? "docs"]))
  return content ??= defineContent({
    route: false,
    live: false,
    markdown: docsMarkdown(docsParserOptions),
    sources: Object.fromEntries([...assets].map(([name, base]) => [name, bundledPages(base)])),
  })
}

/** The parsed body of a page through `content.get()`, or null when its file is gone. Development parses on each read. */
export async function readDocsPage(page: Pick<DocsPage, "file" | "source">): Promise<DocsDocument | null> {
  const document = await docsContent().get(`${sourceOf(page)}/${page.file}`, { fresh: import.meta.dev })
  return document ? docsDocumentOf(document) : null
}
