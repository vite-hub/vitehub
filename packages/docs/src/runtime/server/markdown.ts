import { defineContentMarkdownHandler } from "@vite-hub/content/markdown"
import { serverFetch } from "nitro"
import { useRuntimeConfig } from "nitro/runtime-config"

import { docsAppPath } from "../../navigation.ts"

import type { ContentMiddleware } from "@vite-hub/content/markdown"

/**
 * The Markdown copy of each app page that is not a docs page, at its URL plus `.md` and for `Accept: text/markdown`.
 * Content converts the HTML that Nitro renders for the same request. nuxt-agent-discovery answers the docs pages first.
 * Content loads on the first request that asks for Markdown or gets an HTML page.
 */
const markdown = defineContentMarkdownHandler(
  () => import("../content.ts").then(module => module.docsMarkdownContent()),
  { render: request => serverFetch(request) },
)
const rawMarkdown = defineContentMarkdownHandler(
  () => import("../content.ts").then(module => module.docsMarkdownContent(true)),
)

const handler: ContentMiddleware = async (event, next) => {
  const path = new URL(event.req.url).pathname
  const raw = docsAppPath("/raw/", useRuntimeConfig().public.docs.appBase)
  if (path.startsWith(raw) && path.endsWith(".md")) return await rawMarkdown(event, next)
  return await markdown(event, next)
}

export default handler
