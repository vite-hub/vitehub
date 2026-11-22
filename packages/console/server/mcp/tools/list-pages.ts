import { defineMcpTool } from "vite-hub/mcp"

import { callDocsTool } from "../../../src/docs-mcp.ts"

export default defineMcpTool({
  title: "List Pages",
  description: "Lists every documentation page with its title, path, description, and URL.\n\nUse it to find pages about a topic when you do not know the exact path. Then read a page with get-page.",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  access: "public",
  handler: () => callDocsTool("list-pages", {}),
})
