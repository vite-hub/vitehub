import manifest from "#docs/manifest"
import { defineHandler } from "nitro/h3"
import { useRuntimeConfig } from "nitro/runtime-config"

import type { EventHandler, EventHandlerRequest } from "nitro/h3"
import { docsCanonicalUrl, findDocsPage } from "../../navigation.ts"

/**
 * `/docs/kv/` moves to `/docs/kv` with a 301, the URL that the canonical link and the sitemap name. A page that also
 * answers with a slash is a duplicate, and search engines can index the copy. Static hosts that serve the prerendered
 * `docs/kv.html` first redirect the same way; this covers Node servers and Workers that render the page.
 */
const handler: EventHandler<EventHandlerRequest, Response | undefined> = defineHandler((event) => {
  if (event.req.method !== "GET" && event.req.method !== "HEAD") return
  const { pathname, search } = event.url
  if (pathname.length < 2 || !pathname.endsWith("/")) return
  const { appBase } = useRuntimeConfig().public.docs
  const prefix = appBase.replace(/\/+$/, "")
  const path = prefix && pathname.startsWith(`${prefix}/`) ? pathname.slice(prefix.length) : pathname
  const page = findDocsPage(manifest, path)?.page
  if (!page) return
  const target = docsCanonicalUrl("", page.path, appBase)
  if (target === pathname) return
  return new Response(null, { status: 301, headers: { location: `${target}${search}` } })
})

export default handler
