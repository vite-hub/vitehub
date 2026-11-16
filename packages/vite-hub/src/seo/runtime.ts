import { getStandardContext } from "@vite-hub/runtime"
import { mergeSitemapUrls, renderRobots, renderSitemap, sitemapUrlLimit } from "@vite-hub/internal/sitemap"

import { viteHubErrorDiagnostics } from "../error-diagnostics.ts"

import type { SitemapUrl } from "@vite-hub/internal/sitemap"
import type { SitemapEntries, SitemapEntry } from "../seo.ts"

/** The part of a Content runtime, the default export of `server/content.ts`, that the sitemap and robots.txt read. */
export interface SeoContent {
  readonly seo?: { readonly sitemap?: boolean, readonly robots?: boolean | { readonly disallow?: readonly string[] } }
  readonly access?: "public"
  readonly hasPolicy?: boolean
  can?(context: { user: null, action: "read" }): Promise<boolean>
  sitemap(options: { site: string, waitUntil?: (promise: Promise<unknown>) => void }): Promise<readonly SitemapUrl[]>
}

/** What the generated `/sitemap.xml` route knows from the build. */
export interface SitemapRouteOptions {
  /** The origin from `publicUrl`. `null` in `vite dev`, which uses the request origin. */
  site: string | null
  /** The app base path, such as `/` or `/docs/`. */
  base: string
  /** The static page paths that the build found. */
  pages: readonly string[]
  /** Path prefixes to leave out. */
  exclude: readonly string[]
  /** Loads the default export of `server/sitemap.ts`. */
  app?: () => Promise<SitemapEntries>
  /** Loads the default export of `server/content.ts`. */
  content?: () => Promise<SeoContent>
}

interface Fetchable {
  fetch(request: Request): Promise<Response>
}

function siteOf(options: { site: string | null, base: string }, request: Request): string {
  return `${options.site ?? new URL(request.url).origin}${options.base.replace(/\/+$/, "")}`
}

function excluded(loc: string, site: string, exclude: readonly string[]): boolean {
  if (!exclude.length || !loc.startsWith(site)) return false
  const path = loc.slice(site.length) || "/"
  return exclude.some(prefix => path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`))
}

function isHttpUrl(value: string): boolean {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== ""
}

function appEntry(entry: SitemapEntry, site: string): SitemapUrl {
  const loc: unknown = entry?.loc
  const lastmod: unknown = entry?.lastmod
  const date = lastmod instanceof Date ? lastmod : typeof lastmod === "string" ? new Date(lastmod) : undefined
  const validLoc = typeof loc === "string" && (loc.startsWith("/") ? !loc.startsWith("//") : isHttpUrl(loc))
  if (!validLoc || (lastmod !== undefined && (!date || Number.isNaN(date.getTime())))) {
    throw viteHubErrorDiagnostics.SEO_SITEMAP_ENTRY_INVALID({ entry: JSON.stringify(entry) ?? String(entry) })
  }
  return { loc: loc.startsWith("/") ? `${site}${loc}` : loc, ...date ? { lastmod: date.toISOString() } : {} }
}

/** Whether a request without a user may read the published Content, as `authorize` decides. */
async function contentIsPublic(content: SeoContent): Promise<boolean> {
  if (content.access === "public" || content.hasPolicy !== true) return true
  return await content.can?.({ user: null, action: "read" }) === true
}

/**
 * `/sitemap.xml`: the static pages of the build, the published Content pages with a URL, and the entries of
 * `server/sitemap.ts`, sorted by URL.
 */
export function defineSitemapRoute(options: SitemapRouteOptions): Fetchable {
  return {
    async fetch(request) {
      const site = siteOf(options, request)
      const waitUntil = getStandardContext(request).waitUntil
      let deferred = false
      const content = await options.content?.()
      const [contentUrls, appEntries] = await Promise.all([
        content && content.seo?.sitemap !== false && await contentIsPublic(content)
          ? content.sitemap({
              site,
              ...waitUntil ? { waitUntil: (promise: Promise<unknown>) => { deferred = true; waitUntil(promise) } } : {},
            })
          : [],
        options.app ? options.app().then(entries => typeof entries === "function" ? entries() : entries) : [],
      ])
      const urls = mergeSitemapUrls(
        options.pages.map(path => ({ loc: `${site}${path}` })),
        contentUrls,
        appEntries.map(entry => appEntry(entry, site)),
      ).filter(url => !excluded(url.loc, site, options.exclude))
      if (urls.length > sitemapUrlLimit) throw viteHubErrorDiagnostics.SEO_SITEMAP_TOO_LARGE({ count: urls.length, limit: sitemapUrlLimit })
      return new Response(renderSitemap(urls), {
        // An answer that left date work for after the response has the dates of the previous Content head.
        headers: { "content-type": "application/xml; charset=utf-8", "cache-control": deferred ? "no-store" : "public, max-age=0, must-revalidate" },
      })
    },
  }
}

/**
 * `/robots.txt` that allows crawling, keeps the `disallow` paths and Content's `seo.robots.disallow` paths out, and names
 * the sitemap: the ViteHub one, or Content's own when only Content serves one.
 */
export function defineRobotsRoute(options: { site: string | null, sitemap: boolean, disallow: readonly string[], content?: () => Promise<SeoContent> }): Fetchable {
  return {
    async fetch(request) {
      const seo = (await options.content?.())?.seo
      const contentDisallow = typeof seo?.robots === "object" ? seo.robots.disallow ?? [] : []
      const disallow = [...new Set([...options.disallow, ...contentDisallow])]
      const sitemap = options.sitemap || seo?.sitemap === true ? `${siteOf({ site: options.site, base: "/" }, request)}/sitemap.xml` : undefined
      return new Response(renderRobots({ ...sitemap ? { sitemap } : {}, ...disallow.length ? { disallow } : {} }), {
        headers: { "content-type": "text/plain; charset=utf-8" },
      })
    },
  }
}
