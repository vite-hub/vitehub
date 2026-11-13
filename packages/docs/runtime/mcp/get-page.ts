import { getAgentDocument } from "#agent-discovery"
import { useRequest } from "nitro/context"
import { H3Event, HTTPError } from "nitro/h3"
import { useRuntimeConfig } from "nitro/runtime-config"
import { defineMcpTool } from "@nuxtjs/mcp-toolkit/server"
import { z } from "zod"
import { docsAppPath } from "#docs/navigation"

import type { DocsPublicConfig } from "@vite-hub/docs/nuxt"

export default defineMcpTool({
  name: "get-page",
  description: `Reads one documentation page as Markdown, with its title, description, and URL.

Use a path from list-pages or from a link, such as /docs/getting-started.`,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    path: z.string().describe("Page path from list-pages, such as /docs/getting-started"),
  },
  cache: "1h",
  handler: async ({ path }) => {
    // The same bytes that `/raw/<path>.md` serves through nuxt-agent-discovery, read in the same process.
    // Nitro keeps the request of the MCP call in its async context (`experimental.asyncContext`).
    const event = new H3Event(useRequest())
    const { appBase } = useRuntimeConfig().public.docs as DocsPublicConfig
    const document = await getAgentDocument(event, docsAppPath(path, appBase))
    if (!document || "redirect" in document) throw new HTTPError(`No page at ${path}`, { status: 404 })
    return { title: document.title, path, description: document.description, content: document.markdown, url: document.canonicalUrl }
  },
})
