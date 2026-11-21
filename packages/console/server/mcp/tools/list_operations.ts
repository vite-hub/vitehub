import { defineMcpTool } from "vite-hub/mcp"
import { z } from "zod"

import { projectOperation } from "../../utils/mcp.ts"

export default defineMcpTool({
  title: "List operations",
  description: "Read what a linked app runs: its name, its vite-hub version, its Console sections, and each operation that MCP clients may use in it, with its kind (read, write, or destructive), its description, and the JSON Schema of its input. Read the description before you call an operation: it says which fields to send and what to do after. Run an operation that reads with read_operation, and one that changes data with run_operation.",
  input: z.object({ id: z.string().describe("The app id from list_apps") }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  handler: async ({ id }, { caller }) => {
    const project = await projectOperation(caller, id, "project.get", {})
    if (!project || typeof project !== "object" || !("reference" in project)) return project
    // An app from before `reference` sends only the operation names.
    const { reference, ...rest } = project
    return { ...rest, operations: reference }
  },
})
