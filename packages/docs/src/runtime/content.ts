import { useKV } from "nitro/kv"
import { defineContent } from "@vite-hub/content"
import manifest from "#docs/manifest"

import { docsMarkdownPlugins } from "../markdown.ts"
import { docsManifestPages } from "../navigation.ts"
import { docsParserOptions } from "./documents.ts"

import type { ContentRuntime } from "@vite-hub/content"
import type { DocsPage } from "../types.ts"

/** The server assets folder of a page: `docs`, or `docs-<index>` when the site maps several folders. */
const assetsOf = (page: Pick<DocsPage, "source">) => page.source ?? "docs"
/** The Content name of a docs folder, `docs_<index>`, as `createDocsContent()` names it at build time. */
const contentNameOf = (assets: string) => `docs_${assets === "docs" ? 0 : assets.slice("docs-".length)}`

/** The Content key of a page, such as `docs_0/kv/index.md`. */
export function docsContentKey(page: Pick<DocsPage, "file" | "source">): string {
  return `${contentNameOf(assetsOf(page))}/${page.file}`
}

/**
 * The docs folders as Content Sources over the Markdown that the build bundles as server assets, so they read the same
 * on Node and on Workers. Content parses each page on its first read, with the page plugins, and caches it.
 */
function createRuntimeDocsContent(): ContentRuntime {
  const folders = [...new Set(docsManifestPages(manifest).map(assetsOf))]
  return defineContent({
    route: false,
    live: false,
    // The page plugins, so search reads the same text as the page, such as the Vue file of an `::example`.
    markdown: { plugins: docsMarkdownPlugins(docsParserOptions) },
    sources: Object.fromEntries(folders.map(folder => {
      const assets = useKV(`assets:${folder}`)
      const read = async (key: string) => String(await assets.getItem<string>(key) ?? "")
      // Nitro storage keys use `:` for `/`.
      return [contentNameOf(folder), { keys: async () => (await assets.getKeys()).map(key => key.replaceAll(":", "/")), getItem: read, getItemRaw: read }]
    })),
  })
}

let content: ContentRuntime | undefined
/** One runtime per server. Development reads the files again on each call, so an edited page shows. */
export function useDocsContent(): ContentRuntime {
  if (import.meta.dev) return createRuntimeDocsContent()
  return content ??= createRuntimeDocsContent()
}
