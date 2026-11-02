import { defineEventHandler, setHeader, useRuntimeConfig } from "#imports"

import type { EventHandler, EventHandlerRequest } from "h3"
import manifest from "#docs/manifest"
import { docsManifestPages } from "../../page.ts"

import type { DocsPublicConfig } from "../../nuxt.ts"

const handler: EventHandler<EventHandlerRequest, string> = defineEventHandler((event) => {
  const { site } = useRuntimeConfig(event).public.docs as DocsPublicConfig
  const urls = docsManifestPages(manifest).map(page => `  <url><loc>${escape(`${site.url}${page.path}`)}</loc></url>`)
  setHeader(event, "content-type", "application/xml; charset=utf-8")
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`
})

export default handler

function escape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}
