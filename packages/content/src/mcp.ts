import { serveMcp } from "@vite-hub/internal/runtime/mcp-server"
import { contentReadDenied, contentReadResponse } from "./read-gate.ts"
import { siteOrigin } from "./sitemap.ts"

import type { McpServer, McpTool, McpToolResult } from "@vite-hub/internal/runtime/mcp-server"
import type { ContentHandler } from "./index.ts"
import type { ContentHandlerOptions, ContentReadAccess } from "./read-gate.ts"
import type { ContentRoutedPage, ContentSitemapOptions, DefineContentSeoOptions } from "./sitemap.ts"

/** `defineContent({ seo: { mcp } })`. */
export interface ContentMcpOptions {
  /** The MCP server name that clients show. Defaults to the host name of the site. */
  name?: string
}

/** A published Markdown page, as `content.pages()` and the `list-pages` MCP tool list it. */
export interface ContentPageSummary {
  title: string
  /** The page path, such as `/blog/hello`. */
  path: string
  description?: string
  /** Absolute URL of the page. */
  url: string
}

/** A published Markdown page with its Markdown copy, as `content.page()` and the `get-page` MCP tool read it. */
export interface ContentPageMarkdown extends ContentPageSummary {
  /** The Markdown copy: the title as a heading, the description as a quote, then the body. */
  content: string
}

/** `content.pages()`. */
export interface ContentPagesOptions extends ContentSitemapOptions {
  /** Skip this many pages. Defaults to 0. */
  offset?: number
  /** The most pages to return, default and at most {@link contentPagesLimit}. */
  limit?: number
}

/** `list-pages` returns at most this many pages per call. */
export const contentPagesLimit = 1_000

/** `get-page` cuts a Markdown copy after this many characters. */
export const contentPageCharacters = 200_000

/** The path of a routed page, such as `/blog/hello`. */
export function contentPagePath(loc: string, site?: string): string {
  const path = new URL(loc, "http://localhost").pathname
  // A site mounted below a path, such as `https://example.com/docs`, keeps the path out of page paths.
  const base = site ? new URL(site).pathname.replace(/\/+$/, "") : ""
  return base && (path === base || path.startsWith(`${base}/`)) ? path.slice(base.length) || "/" : path
}

/**
 * The page path that a `get-page` argument names: a path or an absolute URL, with or without a trailing slash or `.md`,
 * in any case. Query and hash are ignored.
 */
export function contentPageKey(path: string): string {
  let pathname = /^https?:\/\//i.test(path) ? new URL(path).pathname : path.split(/[?#]/, 1)[0]!
  if (!pathname.startsWith("/")) pathname = `/${pathname}`
  if (pathname.endsWith(".md")) pathname = pathname === "/index.md" ? "/" : pathname.slice(0, -3)
  try {
    pathname = decodeURI(pathname)
  }
  catch {}
  return (pathname.replace(/\/+$/, "") || "/").toLowerCase()
}

/** The summary of a routed page. A page without a title shows its path. */
export function contentPageSummary(page: ContentRoutedPage, site: string): ContentPageSummary {
  const path = contentPagePath(page.loc, site)
  // Keys in the order of the `@vite-hub/docs` MCP server, so `list-pages` gives the same JSON.
  return { title: page.title ?? path, path, ...page.description ? { description: page.description } : {}, url: new URL(page.loc, site).href }
}

/** The runtime that the MCP server reads. */
export interface ContentMcpRuntime extends ContentReadAccess {
  readonly seo: DefineContentSeoOptions | undefined
  pages(options?: ContentPagesOptions): Promise<ContentPageSummary[]>
  page(path: string, options?: ContentSitemapOptions): Promise<ContentPageMarkdown | null>
}

/** A tool result in the shape that the `@vite-hub/docs` MCP server gives: JSON with two-space indent. */
function json(value: unknown): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError: false }
}

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }

/** The read-only page MCP server of `defineContent({ seo: { mcp } })` for one site origin. */
export function contentMcpServer(content: ContentMcpRuntime, site: string): McpServer {
  const options = typeof content.seo?.mcp === "object" ? content.seo.mcp : {}
  const name = options.name ?? new URL(site).host
  const listPages: McpTool = {
    name: "list-pages",
    description: `Lists every published page with its title, path, description, and URL. It returns at most ${contentPagesLimit} pages; pass offset to read the next ones.

Use it to find pages about a topic when you do not know the exact path. Then read a page with get-page.`,
    annotations: readOnly,
    inputSchema: { type: "object", properties: { offset: { type: "integer", minimum: 0, description: "Pages to skip, for the pages after the first call. Defaults to 0." } }, additionalProperties: false },
    validate: ({ offset }) => offset === undefined || (Number.isSafeInteger(offset) && Number(offset) >= 0) ? undefined : "offset must be a whole number of 0 or more.",
    handler: async ({ offset }) => json(await content.pages({ site, offset: Number(offset ?? 0) })),
  }
  const getPage: McpTool = {
    name: "get-page",
    description: `Reads one page as Markdown, with its title, description, and URL.

Use a path from list-pages or from a link, such as /blog/hello.`,
    annotations: readOnly,
    inputSchema: { type: "object", properties: { path: { type: "string", description: "Page path from list-pages, such as /blog/hello" } }, required: ["path"], additionalProperties: false },
    validate: ({ path }) => String(path) === path && path.trim() ? undefined : "path must be a page path from list-pages, such as /blog/hello.",
    handler: async ({ path }) => {
      const page = await content.page(String(path), { site })
      // The same text as the `@vite-hub/docs` MCP server, where an H3 404 becomes `[404] <message>`.
      if (!page) return { content: [{ type: "text", text: `[404] No page at ${String(path)}` }], isError: true }
      return json({ title: page.title, path: page.path, ...page.description ? { description: page.description } : {}, content: page.content, url: page.url })
    },
  }
  return {
    serverInfo: { name, title: name, version: "1.0.0" },
    instructions: `Read-only access to the published pages of ${name}. Call list-pages to find a page, then get-page to read it as Markdown.`,
    tools: [listPages, getPage],
  }
}

/**
 * Serve the read-only page MCP server at `/mcp`: `list-pages` and `get-page` over the published Markdown pages that the
 * sitemap lists. URLs use `defineContent({ seo: { site } })`, or the request origin. Each request first asks
 * `authorize` with `action: "read"`, as `/api/content/**` does. ViteHub generates this route when
 * `defineContent({ seo: { mcp: true } })`.
 */
export function defineContentMcpHandler(content: ContentMcpRuntime, options: ContentHandlerOptions = {}): ContentHandler {
  return {
    async fetch(request) {
      const mcp = content.seo?.mcp
      if (mcp === undefined || mcp === false) return new Response("Not Found", { status: 404 })
      const denied = await contentReadDenied(content, request, options)
      if (denied) return denied
      return contentReadResponse(content, await serveMcp(request, contentMcpServer(content, content.seo?.site ? siteOrigin(content.seo.site) : new URL(request.url).origin)))
    },
  }
}
