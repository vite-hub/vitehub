import { defineHandler } from "nitro/h3"
import { useRuntimeConfig } from "nitro/runtime-config"

import type { EventHandler, EventHandlerRequest } from "nitro/h3"
import manifest from "#docs/manifest"
import { docsAppPath, docsIndexedPages } from "../../navigation.ts"

import type { DocsPublicConfig } from "../../nuxt.ts"

/** Every indexed page of the manifest and the `sitemap` paths of the options, sorted by URL. */
const handler: EventHandler<EventHandlerRequest, string> = defineHandler((event) => {
  const { site, sitemap, appBase } = useRuntimeConfig().public.docs as DocsPublicConfig
  const paths = [...new Set([...docsIndexedPages(manifest).map(page => page.path), ...sitemap])].sort()
  const urls = paths.map(path => `  <url><loc>${escape(`${site.url}${docsAppPath(path, appBase)}`)}</loc></url>`)
  event.res.headers.set("content-type", "application/xml; charset=utf-8")
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`
})

export default handler

function escape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}
