import { contentSource, defineContent } from "@vite-hub/content"
import agent from "#docs/agent"
import manifest from "#docs/manifest"
import { useRuntimeConfig } from "nitro/runtime-config"
import { docsAgentCopy, docsAgentPages, docsContentSource } from "../agent-copy.ts"
import { docsDocumentOf, docsMarkdown } from "../markdown.ts"
import { docsManifestPages, docsRawPath } from "../navigation.ts"
import { docsParserOptions } from "./documents.ts"
import { readDocsFile } from "./files.ts"

import type { ContentDocumentsRuntime, ContentMarkdownRuntime, ContentRuntime } from "@vite-hub/content"
import type { DocsMarkdownCopy } from "../agent-copy.ts"
import type { DocsDocument } from "../markdown.ts"
import type { DocsPage } from "../types.ts"

type ContentSource = Extract<NonNullable<Parameters<typeof defineContent>[0]>["sources"], object>[string]

/** One docs folder as a Content Source, from the production bundle or development server assets. */
function bundledPages(base: string): ContentSource {
  const read = (key: string) => readDocsFile(base, key)
  return {
    keys: async () => docsManifestPages(manifest).filter(page => (page.source ?? "docs") === base).map(page => page.file),
    getItem: async (key: string) => await read(key) ?? "",
    getItemRaw: read,
  }
}

/** The docs Content: its reads, and the agent files of its Source pages. */
export type DocsContent = ContentRuntime & ContentDocumentsRuntime

let content: { runtime: DocsContent, siteUrl: string } | undefined
let rawPages: Map<string, DocsPage> | undefined

function docsRawPage(path: string): DocsPage | undefined {
  rawPages ??= new Map(docsManifestPages(manifest).map(page => [docsRawPath(page.path), page]))
  return rawPages.get(path)
}

function docsSiteUrl(config: { site: { url: string }, appBase: string }): string {
  return `${config.site.url}${config.appBase.replace(/\/+$/, "")}`
}

/** The agent copy of a page from its file. The `rawMarkdown` option runs at build time, and the build keeps each page that it changed. */
async function docsPageCopy(page: DocsPage, text: string, siteUrl: string): Promise<DocsMarkdownCopy> {
  const rewritten = await readDocsFile("docs-agent", `${docsContentSource(page)}/${page.file}`)
  return docsAgentCopy(manifest, page, rewritten === null ? text : String(rewritten), siteUrl)
}

async function readDocsPageCopy(page: DocsPage): Promise<string | null> {
  const text = await readDocsFile(page.source ?? "docs", page.file)
  if (text === null) return null
  const copy = await docsPageCopy(page, text, docsSiteUrl(useRuntimeConfig().public.docs))
  return `${copy.markdown}${copy.footer}`
}

/** Read an exact manifest URL without listing or parsing the Content Sources. */
export async function readDocsRawCopy(rawPath: string): Promise<string | null> {
  const page = docsRawPage(rawPath)
  return page ? await readDocsPageCopy(page) : null
}

/** Use the manifest for canonical Docs twins and Content for other page lookups. */
export function docsMarkdownContent(): ContentMarkdownRuntime {
  const runtime = docsContent()
  const base = useRuntimeConfig().public.docs.appBase.replace(/\/+$/, "")
  function twin(path: string): DocsPage | undefined {
    const relative = base && path.startsWith(`${base}/`) ? path.slice(base.length) : path
    try {
      return docsRawPage(`/raw${decodeURI(relative)}`)
    }
    catch (error) {
      if (!(error instanceof URIError)) throw error
    }
  }
  return {
    seo: runtime.seo,
    async markdown(path, options) {
      const page = twin(path)
      return page ? await readDocsPageCopy(page) : await runtime.markdown(path, options)
    },
    async hasMarkdown(path) {
      const page = twin(path)
      return page ? (await readDocsFile(page.source ?? "docs", page.file)) !== null : await runtime.hasMarkdown(path)
    },
  }
}

/**
 * The docs pages as Content, parsed with the site's parser. The first read creates it. Each page has its URL from the
 * manifest, so Content serves the agent files: the `/raw/<page>.md` copies, `llms.txt`, `llms-full.txt`, `sitemap.md`,
 * the sitemap pages, and the MCP server.
 */
export function docsContent(): DocsContent {
  const config = useRuntimeConfig().public.docs
  // The public origin with the app base, such as `https://docs.example.com/portal`. Empty keeps links relative.
  const siteUrl = docsSiteUrl(config)
  if (content?.siteUrl === siteUrl) return content.runtime
  const pages = docsAgentPages(manifest)
  const assets = new Map(docsManifestPages(manifest).map(page => [docsContentSource(page), page.source ?? "docs"]))
  const sources = Object.fromEntries([...assets].map(([name, base]) => {
    const byKey = pages.get(name) ?? new Map<string, DocsPage>()
    return [name, contentSource(bundledPages(base), {
      url: ({ key }) => key === undefined ? null : byKey.get(key)?.path ?? null,
      label: "Docs",
      seo: ({ key }) => {
        const page = key === undefined ? undefined : byKey.get(key)
        return page && { title: page.sourceTitle, ...page.description ? { description: page.description } : {}, ...page.seo?.index === false ? { noindex: true } : {} }
      },
      markdown: async ({ key, text }): Promise<DocsMarkdownCopy | null> => {
        const page = byKey.get(key)
        return page ? await docsPageCopy(page, text, siteUrl) : null
      },
    })]
  }))
  const runtime = defineContent({
    route: false,
    live: false,
    markdown: docsMarkdown(docsParserOptions),
    sources,
    seo: {
      ...config.site.url ? { site: siteUrl } : {},
      sitemap: true,
      markdown: { prefix: "/raw", pages: config.markdownPages },
      llms: { title: config.site.name, ...config.site.description ? { description: config.site.description } : {}, ...agent.llms },
      mcp: config.mcp ? { name: config.mcp.name } : false,
    },
  })
  content = { runtime, siteUrl }
  return runtime
}

/**
 * The parsed body of a page through `content.get()`, or null when its file is gone. The page route and search both read
 * here, so a page parses once per server. Development parses on each read.
 */
export async function readDocsPage(page: Pick<DocsPage, "file" | "source">): Promise<DocsDocument | null> {
  const document = await docsContent().get(`${docsContentSource(page)}/${page.file}`, { fresh: import.meta.dev })
  return document ? docsDocumentOf(document) : null
}
