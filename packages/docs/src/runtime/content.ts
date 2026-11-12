import { defineContent } from "@vite-hub/content"
import manifest from "#docs/manifest"
import { useKV } from "nitro/kv"
import { docsDocumentOf, docsMarkdown } from "../markdown.ts"
import { docsManifestPages } from "../navigation.ts"
import { docsParserOptions } from "./documents.ts"

import type { ContentRuntime } from "@vite-hub/content"
import type { DocsDocument } from "../markdown.ts"
import type { DocsPage } from "../types.ts"

type ContentSource = Extract<NonNullable<Parameters<typeof defineContent>[0]>["sources"], object>[string]

/** The Content Source of a page, named like `createDocsContent()` names it: `docs_<index>` for the server asset `docs-<index>`. */
const sourceOf = (page: Pick<DocsPage, "source">) => `docs_${page.source ? page.source.slice("docs-".length) : 0}`

/** The pages of one docs folder from the server assets that the build bundles, as a Content Source. */
function serverAssets(base: string): ContentSource {
  const storage = useKV(`assets:${base}`)
  return {
    keys: async () => (await storage.getKeys()).map(key => key.replaceAll(":", "/")),
    getItem: async (key: string) => String(await storage.getItem(key) ?? ""),
    getItemRaw: (key: string) => storage.getItemRaw(key),
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
    sources: Object.fromEntries([...assets].map(([name, base]) => [name, serverAssets(base)])),
  })
}

/**
 * The parsed body of a page through `content.get()`, or null when its file is gone. The page route and search both read
 * here, so a page parses once per server. Development parses on each read.
 */
export async function readDocsPage(page: Pick<DocsPage, "file" | "source">): Promise<DocsDocument | null> {
  const document = await docsContent().get(`${sourceOf(page)}/${page.file}`, { fresh: import.meta.dev })
  return document ? docsDocumentOf(document) : null
}
