export interface SitemapEntry {
  path: string;
  lastmod?: string;
}

export function generateSitemap(entries: SitemapEntry[], siteUrl: string): string {
  const origin = siteUrl.replace(/\/+$/, "");
  const urls = new Map<string, SitemapEntry>();

  for (const entry of entries) {
    if (entry.path.endsWith(".navigation") || entry.path.includes("/.navigation/")) continue;
    const path = normalizePath(entry.path);
    const existing = urls.get(path);
    if (!existing || (!existing.lastmod && entry.lastmod)) {
      urls.set(path, entry);
    }
  }

  const body = [...urls.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, entry]) => {
      const lastmod = entry.lastmod
        ? `\n    <lastmod>${escapeXml(entry.lastmod.split("T")[0] || entry.lastmod)}</lastmod>`
        : "";

      return `  <url>\n    <loc>${escapeXml(`${origin}${path}`)}</loc>${lastmod}\n  </url>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>`;
}

function normalizePath(path: string): string {
  const absolutePath = path.startsWith("/") ? path : `/${path}`;
  return absolutePath === "/" ? absolutePath : `${absolutePath.replace(/\/+$/, "")}/`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
