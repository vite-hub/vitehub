import { contentKV } from "./source-heads.ts"
import { escapeXml } from "./sitemap.ts"

import type { ContentRoutedPage, ContentRssOptions } from "./sitemap.ts"

/** One item of the Content RSS feed. */
export interface ContentRssItem {
  title: string
  /** Absolute URL of the page. It is also the `guid`, so an edit does not make the page a new item. */
  link: string
  description?: string
  /** When the page last changed, as an ISO timestamp. */
  date?: string
}

export interface ContentRssChannel {
  title: string
  /** The site, such as `https://example.com`. */
  link: string
  description: string
  /** Absolute URL of the feed itself. */
  self: string
}

/** Default number of feed items. */
export const contentRssLimit: number = 20

/**
 * The feed items: Markdown pages, newest first by `date` (the latest history entry, else the `date` field). Pages
 * without a date go last, in URL order.
 */
export function contentRssItems(pages: readonly ContentRoutedPage[], dates: ReadonlyMap<ContentRoutedPage, string>, limit: number = contentRssLimit): ContentRssItem[] {
  const items = pages.filter(page => page.markdown).map((page) => {
    const item: ContentRssItem = { title: page.title ?? page.loc, link: page.loc }
    if (page.description) item.description = page.description
    const date = page.lastmod ?? dates.get(page) ?? page.date
    if (date) item.date = date
    return item
  })
  const time = (item: ContentRssItem) => item.date ? Date.parse(item.date) : Number.NEGATIVE_INFINITY
  items.sort((left, right) => time(right) - time(left) || (left.link < right.link ? -1 : left.link > right.link ? 1 : 0))
  return items.slice(0, limit)
}

/** Render an RSS 2.0 document. `lastBuildDate` is the newest item date, so the same pages give the same bytes. */
export function renderContentRss(channel: ContentRssChannel, items: readonly ContentRssItem[]): string {
  const rfc822 = (date: string) => new Date(date).toUTCString()
  const newest = items.find(item => item.date)?.date
  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">`,
    `  <channel>`,
    `    <title>${escapeXml(channel.title)}</title>`,
    `    <link>${escapeXml(channel.link)}</link>`,
    `    <description>${escapeXml(channel.description)}</description>`,
    `    <atom:link href="${escapeXml(channel.self)}" rel="self" type="application/rss+xml"/>`,
    ...(newest ? [`    <lastBuildDate>${rfc822(newest)}</lastBuildDate>`] : []),
    ...items.flatMap(item => [
      `    <item>`,
      `      <title>${escapeXml(item.title)}</title>`,
      `      <link>${escapeXml(item.link)}</link>`,
      ...(item.description ? [`      <description>${escapeXml(item.description)}</description>`] : []),
      `      <guid isPermaLink="true">${escapeXml(item.link)}</guid>`,
      ...(item.date ? [`      <pubDate>${rfc822(item.date)}</pubDate>`] : []),
      `    </item>`,
    ]),
    `  </channel>`,
    `</rss>`,
  ]
  return `${lines.join("\n")}\n`
}

/** The channel of `defineContent({ seo: { rss } })` for a site origin. */
export function contentRssChannel(options: ContentRssOptions, site: string): ContentRssChannel {
  const title = options.title ?? new URL(site).host
  return { title, link: `${site}/`, description: options.description ?? title, self: `${site}/rss.xml` }
}

/** Generated files that one server instance holds in memory. */
const memoryFiles = 32

async function stateHash(state: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(state)))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("")
}

/**
 * A cache of generated files, such as the feed, keyed by the state they come from: the page list and the head commit
 * of each `github()` Source. A hit reads memory, then ViteHub KV, and never GitHub. A failed build is not kept.
 */
export function createContentFileCache(): (kind: string, state: unknown, build: () => Promise<string>) => Promise<string> {
  const files = new Map<string, Promise<string>>()
  return async function cached(kind: string, state: unknown, build: () => Promise<string>): Promise<string> {
    const key = `content:${kind}:${await stateHash(state)}`
    let pending = files.get(key)
    if (pending) {
      files.delete(key)
      files.set(key, pending)
      return await pending
    }
    pending = (async () => {
      const kv = contentKV()
      if (!kv) return await build()
      const [error, stored] = await kv.get<string>(key).catch((cause: unknown) => [cause, undefined] as const)
      if (!error && String(stored) === stored) return stored
      const built = await build()
      await kv.set(key, built).catch(() => undefined)
      return built
    })()
    files.set(key, pending)
    pending.catch(() => {
      if (files.get(key) === pending) files.delete(key)
    })
    while (files.size > memoryFiles) files.delete(files.keys().next().value!)
    return await pending
  }
}
