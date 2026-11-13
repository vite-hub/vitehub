import { defineMcpTool } from "vite-hub/mcp"

import { callDocsTool } from "../../../src/docs-mcp.ts"

// The same tool as list-pages of https://vitehub.dev/mcp. The call goes to that server.
export default defineMcpTool({
  title: "List Pages",
  description: "Lists every documentation page with its title, path, description, and URL.\n\nUse it to find pages about a topic when you do not know the exact path. Then read a page with get-page.",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  public: true,
  handler: () => callDocsTool("list-pages", {}),
})
