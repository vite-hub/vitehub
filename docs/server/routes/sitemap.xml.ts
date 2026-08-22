import { queryCollection } from "@nuxt/content/server";
import { generateSitemap, type SitemapEntry } from "../utils/sitemap";

interface ContentPage {
  path: string;
  modifiedAt?: string;
  sitemap?: boolean;
}

export default defineEventHandler(async (event) => {
  const [docs, blog, trust] = await Promise.all([
    queryCollection(event, "docs").all(),
    queryCollection(event, "blog").all(),
    queryCollection(event, "trust").all(),
  ]);
  const entries: SitemapEntry[] = [{ path: "/" }, { path: "/blog" }, { path: "/examples" }];

  for (const page of [...docs, ...blog, ...trust] as ContentPage[]) {
    if (page.sitemap === false) continue;
    entries.push({ path: page.path, lastmod: page.modifiedAt });
  }

  const sitemap = generateSitemap(entries, getSiteConfig(event).url || "");

  setResponseHeader(event, "content-type", "application/xml");
  return sitemap;
});
