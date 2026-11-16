import { defineContentMarkdownHandler } from "@vite-hub/content/markdown"
import { serverFetch } from "nitro"

import type { ContentMiddleware } from "@vite-hub/content/markdown"

/**
 * The Markdown copy of each app page that is not a docs page, at its URL plus `.md` and for `Accept: text/markdown`.
 * Content converts the HTML that Nitro renders for the same request. nuxt-agent-discovery answers the docs pages first.
 * Content loads on the first request that asks for Markdown or gets an HTML page.
 */
const handler: ContentMiddleware = defineContentMarkdownHandler(
  () => import("../content.ts").then(module => module.docsContent()),
  { render: request => serverFetch(request) },
)

export default handler
