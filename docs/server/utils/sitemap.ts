export interface SitemapEntry {
  path: string;
  lastmod?: string;
}

export interface SitemapUrl {
  loc: string;
  lastmod?: string;
}

export function sitemapUrls(entries: SitemapEntry[]): SitemapUrl[] {
  const urls = new Map<string, SitemapEntry>();

  for (const entry of entries) {
    if (entry.path.endsWith(".navigation") || entry.path.includes("/.navigation/")) continue;
    const path = normalizePath(entry.path);
    const existing = urls.get(path);
    if (!existing || (!existing.lastmod && entry.lastmod)) {
      urls.set(path, entry);
    }
  }

  return [...urls.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([loc, entry]) => entry.lastmod ? { loc, lastmod: entry.lastmod.split("T")[0] || entry.lastmod } : { loc });
}

// Matches the canonical URLs, which have no trailing slash.
function normalizePath(path: string): string {
  const absolutePath = path.startsWith("/") ? path : `/${path}`;
  return absolutePath.replace(/\/+$/, "") || "/";
}
