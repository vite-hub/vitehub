import { defineEventHandler, setHeader, useRuntimeConfig } from "#imports"

import type { EventHandler, EventHandlerRequest } from "h3"
import manifest from "#docs/manifest"
import { docsManifestPages } from "../../navigation.ts"

import type { DocsPublicConfig } from "../../nuxt.ts"

/** Every page of the manifest and the `sitemap` paths of the options, sorted by URL. */
const handler: EventHandler<EventHandlerRequest, string> = defineEventHandler((event) => {
  const { site, sitemap } = useRuntimeConfig(event).public.docs as DocsPublicConfig
  const paths = [...new Set([...docsManifestPages(manifest).map(page => page.path), ...sitemap])].sort()
  const urls = paths.map(path => `  <url><loc>${escape(`${site.url}${path}`)}</loc></url>`)
  setHeader(event, "content-type", "application/xml; charset=utf-8")
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`
})

export default handler

function escape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}
