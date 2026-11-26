import { defineMcpTool } from "vite-hub/mcp"
import { z } from "zod"

import { projectOperation } from "../../utils/mcp.ts"

export default defineMcpTool({
  title: "Run an operation",
  description: "Run one operation of a linked app that writes data without deleting or publishing it, such as kv.set, comments.create, or comments.resolve, signed by the Console for you. For operations that only read, such as kv.list or logs.list, use read_operation. For an operation that deletes or publishes data, use run_destructive_operation. list_operations names the operations, gives the kind and the fields of each, and the app refuses operations that it keeps from MCP clients. After you make the change that a comment thread asks for, resolve the thread with comments.resolve and a reply that says what changed, such as the commit or a link. Resolve all the threads that you handled in one call, with { threads: [{ threadId, reply }] }.",
  input: z.object({
    id: z.string().describe("The app id from list_apps"),
    operation: z.string().describe("The operation name from list_operations, such as kv.set"),
    input: z.record(z.string(), z.unknown()).optional().describe("The input of the operation"),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  handler: async ({ id, input, operation }, { caller }) => projectOperation(caller, id, operation, input ?? {}),
})
