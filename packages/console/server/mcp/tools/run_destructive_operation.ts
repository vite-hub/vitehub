import { defineMcpTool } from "vite-hub/mcp"
import { z } from "zod"

import { projectOperation } from "../../utils/mcp.ts"

export default defineMcpTool({
  title: "Run a destructive operation",
  description: "Run a change on a linked app other than comments.reply or comments.resolve. This includes operations of kind write that can replace existing data, such as kv.set and blob.put. Use read_operation for dry runs, including content.publish with dryRun: true. Explain the change to the user and pass confirm: true only after they agree.",
  input: z.object({
    id: z.string().describe("The app id from list_apps"),
    operation: z.string().describe("The operation name from list_operations, such as kv.delete"),
    input: z.record(z.string(), z.unknown()).optional().describe("The input of the operation"),
    confirm: z.literal(true).describe("The caller asserts that the user agreed to the change"),
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  handler: async ({ confirm, id, input, operation }, { caller }) => projectOperation(caller, id, operation, input ?? {}, { confirmed: confirm }),
})
