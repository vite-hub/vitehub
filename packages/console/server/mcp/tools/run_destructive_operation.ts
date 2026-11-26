import { defineMcpTool } from "vite-hub/mcp"
import { z } from "zod"

import { projectOperation } from "../../utils/mcp.ts"

export default defineMcpTool({
  title: "Run a destructive operation",
  description: "Run one operation of a linked app that deletes or publishes data, such as kv.delete, comments.delete, or content.publish, signed by the Console for you. list_operations marks these operations destructive. Before you call this tool, tell the person what the operation changes, and call it only when they agree. For an operation that writes without deleting or publishing, use run_operation.",
  input: z.object({
    id: z.string().describe("The app id from list_apps"),
    operation: z.string().describe("The operation name from list_operations, such as kv.delete"),
    input: z.record(z.string(), z.unknown()).optional().describe("The input of the operation"),
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  handler: async ({ id, input, operation }, { caller }) => projectOperation(caller, id, operation, input ?? {}, { confirmed: true }),
})
