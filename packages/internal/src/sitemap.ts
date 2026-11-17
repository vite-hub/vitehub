/** One URL of a sitemap. */
export interface SitemapUrl {
  /** The absolute URL of the page. */
  loc: string
  /** When the page last changed, as an ISO timestamp. */
  lastmod?: string
}

/** One sitemap file holds at most this many URLs. */
export const sitemapUrlLimit = 50_000

export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;" })[character]!)
}

/**
 * Join lists of sitemap URLs into one list sorted by URL, so the same pages always give the same file. A URL that is
 * in more than one list is kept once, with the first `lastmod` that a list gives.
 */
export function mergeSitemapUrls(...lists: ReadonlyArray<readonly SitemapUrl[]>): SitemapUrl[] {
  const urls = new Map<string, SitemapUrl>()
  for (const list of lists) {
    for (const { loc, lastmod } of list) {
      const known = urls.get(loc)
      if (!known) urls.set(loc, lastmod ? { loc, lastmod } : { loc })
      else if (!known.lastmod && lastmod) known.lastmod = lastmod
    }
  }
  return [...urls.values()].sort((left, right) => left.loc < right.loc ? -1 : left.loc > right.loc ? 1 : 0)
}

/** Render a sitemaps.org `urlset` document, in the order of `entries`. */
export function renderSitemap(entries: readonly SitemapUrl[]): string {
  const urls = entries.map(entry => `  <url>\n    <loc>${escapeXml(entry.loc)}</loc>${entry.lastmod ? `\n    <lastmod>${escapeXml(entry.lastmod)}</lastmod>` : ""}\n  </url>`)
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}${urls.length ? "\n" : ""}</urlset>\n`
}

/** robots.txt that allows every crawler, keeps `disallow` paths out, and names `sitemap`, an absolute URL, when set. */
export function renderRobots(options: { sitemap?: string, disallow?: readonly string[] }): string {
  const lines = ["User-agent: *", ...(options.disallow?.length ? options.disallow.map(path => `Disallow: ${path}`) : ["Allow: /"])]
  if (options.sitemap) lines.push("", `Sitemap: ${options.sitemap}`)
  return `${lines.join("\n")}\n`
}
