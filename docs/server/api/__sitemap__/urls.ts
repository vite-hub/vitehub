import { queryCollection } from "@nuxt/content/server";
import { defineEventHandler } from "h3";
import { type SitemapEntry, sitemapUrls } from "../../utils/sitemap";

// Replaces the Docus source: ViteHub lists docs and trust pages plus its own app pages.
export default defineEventHandler(async (event) => {
  const [docs, trust] = await Promise.all([
    queryCollection(event, "docs").all(),
    queryCollection(event, "trust").all(),
  ]);
  const entries: SitemapEntry[] = [{ path: "/" }, { path: "/guides" }, { path: "/examples" }];

  for (const page of [...docs, ...trust]) {
    if (page.sitemap === false) continue;
    entries.push({ path: page.path, lastmod: page.modifiedAt });
  }

  return sitemapUrls(entries);
});
