import { listAgentPages } from "#agent-discovery"
import { useRuntimeConfig } from "#imports"
import { useEvent } from "nitropack/runtime"
import { defineMcpTool } from "@nuxtjs/mcp-toolkit/server"

import type { DocsPublicConfig } from "@vite-hub/docs/nuxt"

export default defineMcpTool({
  name: "list-pages",
  description: `Lists every documentation page with its title, path, description, and URL.

Use it to find pages about a topic when you do not know the exact path. Then read a page with get-page.`,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  cache: "1h",
  handler: async () => {
    const event = useEvent()
    const { appBase } = useRuntimeConfig(event).public.docs as DocsPublicConfig
    const prefix = appBase.replace(/\/+$/, "")
    const pages = await listAgentPages(event)
    return pages.map(page => ({ title: page.title, path: page.route.startsWith(`${prefix}/`) ? page.route.slice(prefix.length) || "/" : page.route, description: page.description, url: page.url }))
  },
})
