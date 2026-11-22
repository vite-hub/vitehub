import { defineMcpTool } from "vite-hub/mcp"
import { z } from "zod"

import { projectOperation } from "../../utils/mcp.ts"

export default defineMcpTool({
  title: "Read with an operation",
  description: "Run one operation of a linked app that only reads, such as kv.list, logs.list, or comments.threads, signed by the Console for you. list_operations names the operations and gives the fields of each input. The app refuses an operation that changes data: run it with run_operation.",
  input: z.object({
    id: z.string().describe("The app id from list_apps"),
    operation: z.string().describe("The operation name from list_operations, such as kv.list"),
    input: z.record(z.string(), z.unknown()).optional().describe("The input of the operation"),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  handler: async ({ id, input, operation }, { caller }) => projectOperation(caller, id, operation, input ?? {}, { readOnly: true }),
})
