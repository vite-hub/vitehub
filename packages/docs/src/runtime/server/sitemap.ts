import { mergeSitemapUrls, renderSitemap } from "@vite-hub/internal/sitemap"
import { defineHandler } from "nitro/h3"
import { useRuntimeConfig } from "nitro/runtime-config"

import type { EventHandler, EventHandlerRequest } from "nitro/h3"
import { docsAppPath } from "../../navigation.ts"
import { docsContent } from "../content.ts"

/** The indexed pages from Content and the `sitemap` paths of the options, sorted by URL. */
const handler: EventHandler<EventHandlerRequest, Promise<string>> = defineHandler(async (event) => {
  const { site, sitemap, appBase } = useRuntimeConfig().public.docs
  const origin = site.url || event.url.origin
  const entries = await docsContent().sitemap({ site: `${origin}${appBase.replace(/\/+$/, "")}` })
  const extra = sitemap.map(path => ({ loc: `${origin}${docsAppPath(path, appBase)}` }))
  event.res.headers.set("content-type", "application/xml; charset=utf-8")
  return renderSitemap(mergeSitemapUrls(entries, extra))
})

export default handler
