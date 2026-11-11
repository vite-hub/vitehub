import { defineMcpTool } from "vite-hub/mcp"
import { z } from "zod"

import { callDocsTool } from "../../../src/docs-mcp.ts"

// The same tool as get-page of https://vitehub.dev/mcp. The call goes to that server.
export default defineMcpTool({
  title: "Get Page",
  description: "Reads one documentation page as Markdown, with its title, description, and URL.\n\nUse a path from list-pages or from a link, such as /docs/getting-started.",
  input: z.object({ path: z.string().describe("Page path from list-pages, such as /docs/getting-started") }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  public: true,
  handler: ({ path }) => callDocsTool("get-page", { path }),
})
