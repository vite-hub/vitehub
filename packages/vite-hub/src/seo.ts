/** One page that `server/sitemap.ts` adds to `/sitemap.xml`. */
export interface SitemapEntry {
  /** The page path, such as `/blog/hello`, or an absolute `http(s)` URL. A path starts after the app base. */
  loc: string
  /** When the page last changed. */
  lastmod?: string | Date
}

/** The pages of `server/sitemap.ts`: a list, or a function that returns the current list on each request. */
export type SitemapEntries = readonly SitemapEntry[] | (() => readonly SitemapEntry[] | Promise<readonly SitemapEntry[]>)

/**
 * The default export of `server/sitemap.ts`: pages that ViteHub cannot find by itself, such as one page for each
 * product in the Database. `vitehub({ seo: { sitemap: true } })` adds them to `/sitemap.xml`.
 *
 * ```ts
 * export default defineSitemap(async () => {
 *   const products = await useDatabase().select().from(schema.products)
 *   return products.map(product => ({ loc: `/products/${product.slug}`, lastmod: product.updatedAt }))
 * })
 * ```
 */
export function defineSitemap(entries: SitemapEntries): SitemapEntries {
  return entries
}
