import { defineMcpTool } from "vite-hub/mcp"
import { z } from "zod"

import { projectOperation } from "../../utils/mcp.ts"

export default defineMcpTool({
  title: "List operations",
  description: "List the linked app's operations available to MCP, with their kinds, descriptions, and input JSON Schemas. Use read_operation for reads and dry runs (including content.publish with dryRun: true), run_operation for comments.reply and comments.resolve, and run_destructive_operation with confirm: true after user approval for all other changes, even if their kind is write.",
  input: z.object({ id: z.string().describe("The app id from list_apps") }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  handler: async ({ id }, { caller }) => {
    const project = await projectOperation(caller, id, "project.get", {})
    if (!project || typeof project !== "object" || !("reference" in project)) return project
    const { reference, ...rest } = project
    return { ...rest, operations: reference }
  },
})
