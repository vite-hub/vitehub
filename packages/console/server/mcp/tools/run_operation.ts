import { defineMcpTool } from "vite-hub/mcp"
import { z } from "zod"

import { projectOperation } from "../../utils/mcp.ts"

export default defineMcpTool({
  title: "Run an operation",
  description: "Run one operation of a linked app, such as kv.list or logs.list, signed by the Console for you. list_operations names the operations. The app runs it as an MCP call: it refuses operations that it keeps from MCP clients, and an operation that deletes or publishes data unless confirm is true. Tell the person what it changes, and set confirm only when they agree.",
  input: z.object({
    id: z.string().describe("The app id from list_apps"),
    operation: z.string().describe("The operation name from list_operations, such as kv.list"),
    input: z.record(z.string(), z.unknown()).optional().describe("The input of the operation"),
    confirm: z.boolean().optional().describe("true runs an operation that deletes or publishes data. The person must agree first."),
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  handler: async ({ confirm, id, input, operation }, { caller }) => projectOperation(caller, id, operation, input ?? {}, confirm === true),
})
