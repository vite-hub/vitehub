import { defineMcpTool } from "vite-hub/mcp"
import { z } from "zod"

import { projectOperation } from "../../utils/mcp.ts"

export default defineMcpTool({
  title: "Run an operation",
  description: "Run one operation of a linked app that changes data, such as kv.set or comments.create, signed by the Console for you. For operations that only read, such as kv.list or logs.list, use read_operation. list_operations names the operations and gives the fields of each input. The app runs it as an MCP call: it refuses operations that it keeps from MCP clients, and an operation that deletes or publishes data unless confirm is true. For such an operation, tell the person what it changes, and set confirm only when they agree. An operation that ends a task does not need that question: after you make the change that a comment thread asks for, resolve the thread with comments.resolve and a reply that says what changed, such as the commit or a link. Resolve all the threads that you handled in one call, with { threads: [{ threadId, reply }] }.",
  input: z.object({
    id: z.string().describe("The app id from list_apps"),
    operation: z.string().describe("The operation name from list_operations, such as kv.list"),
    input: z.record(z.string(), z.unknown()).optional().describe("The input of the operation"),
    confirm: z.boolean().optional().describe("true runs an operation that deletes or publishes data. The person must agree first."),
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  handler: async ({ confirm, id, input, operation }, { caller }) => projectOperation(caller, id, operation, input ?? {}, { confirmed: confirm === true }),
})
