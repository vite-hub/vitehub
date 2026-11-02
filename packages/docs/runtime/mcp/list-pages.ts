import { listAgentPages } from "#agent-discovery"
import { useEvent } from "nitropack/runtime"
import { defineMcpTool } from "@nuxtjs/mcp-toolkit/server"

export default defineMcpTool({
  name: "list-pages",
  description: `Lists every documentation page with its title, path, description, and URL.

Use it to find pages about a topic when you do not know the exact path. Then read a page with get-page.`,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  cache: "1h",
  handler: async () => {
    const pages = await listAgentPages(useEvent())
    return pages.map(page => ({ title: page.title, path: page.route, description: page.description, url: page.url }))
  },
})
