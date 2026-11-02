import { getAgentDocument } from "#agent-discovery"
import { createError, useEvent, useRuntimeConfig } from "#imports"
import { defineMcpTool } from "@nuxtjs/mcp-toolkit/server"
import { z } from "zod"
import { docsAppPath } from "#docs/navigation"

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
    const event = useEvent()
    const { appBase } = useRuntimeConfig(event).public.docs
    const document = await getAgentDocument(event, docsAppPath(path, appBase))
    if (!document || "redirect" in document) throw createError({ statusCode: 404, statusMessage: `No page at ${path}` })
    return { title: document.title, path, description: document.description, content: document.markdown, url: document.canonicalUrl }
  },
})
