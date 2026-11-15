import { defineMcpTool } from "vite-hub/mcp"
import { z } from "zod"

import { projectOperation } from "../../utils/mcp.ts"

export default defineMcpTool({
  title: "List operations",
  description: "Read what a linked app runs: its name, its vite-hub version, and the Console sections and operations that MCP clients may use in it. Run one with run_operation.",
  input: z.object({ id: z.string().describe("The app id from list_apps") }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  handler: async ({ id }, { caller }) => projectOperation(caller, id, "project.get", {}),
})
