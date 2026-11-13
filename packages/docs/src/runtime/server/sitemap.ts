import { renderContentSitemap } from "@vite-hub/content"
import { defineHandler } from "nitro/h3"
import { useRuntimeConfig } from "nitro/runtime-config"

import type { EventHandler, EventHandlerRequest } from "nitro/h3"
import { docsAppPath } from "../../navigation.ts"
import { docsContent } from "../content.ts"

import type { DocsPublicConfig } from "../../nuxt.ts"

/** The indexed pages from Content and the `sitemap` paths of the options, sorted by URL. */
const handler: EventHandler<EventHandlerRequest, Promise<string>> = defineHandler(async (event) => {
  const { site, sitemap, appBase } = useRuntimeConfig().public.docs as DocsPublicConfig
  const origin = site.url || event.url.origin
  const entries = await docsContent().sitemap({ site: `${origin}${appBase.replace(/\/+$/, "")}` })
  const listed = new Set(entries.map(entry => entry.loc))
  const extra = sitemap.map(path => `${origin}${docsAppPath(path, appBase)}`).filter(loc => !listed.has(loc))
  const sorted = [...entries, ...extra.map(loc => ({ collection: "docs", id: loc, loc }))].sort((left, right) => left.loc < right.loc ? -1 : left.loc > right.loc ? 1 : 0)
  event.res.headers.set("content-type", "application/xml; charset=utf-8")
  return renderContentSitemap(sorted)
})

export default handler
