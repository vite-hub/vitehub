import { mergeSitemapUrls, renderSitemap } from "@vite-hub/internal/sitemap"
import { defineHandler } from "nitro/h3"
import { useRuntimeConfig } from "nitro/runtime-config"

import type { EventHandler, EventHandlerRequest } from "nitro/h3"
import { docsCanonicalUrl } from "../../navigation.ts"
import { docsContent } from "../content.ts"

/** The indexed pages from Content and the `sitemap` paths of the options, sorted by URL, as their canonical links name them. */
const handler: EventHandler<EventHandlerRequest, Promise<string>> = defineHandler(async (event) => {
  const { site, sitemap, appBase } = useRuntimeConfig().public.docs
  const origin = site.url || event.url.origin
  const mounted = `${origin}${appBase.replace(/\/+$/, "")}`
  // Content joins the site and the page path, so the home of an app below `/portal/` would be `/portal/`.
  const entries = (await docsContent().sitemap({ site: mounted })).map(entry => ({ ...entry, loc: docsCanonicalUrl(origin, entry.loc.slice(mounted.length), appBase) }))
  const extra = sitemap.map(path => ({ loc: docsCanonicalUrl(origin, path, appBase) }))
  event.res.headers.set("content-type", "application/xml; charset=utf-8")
  return renderSitemap(mergeSitemapUrls(entries, extra))
})

export default handler
