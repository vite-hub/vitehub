import { defineMcpTool } from "vite-hub/mcp"
import { z } from "zod"

import { projectOperation } from "../../utils/mcp.ts"

export default defineMcpTool({
  title: "Read with an operation",
  description: "Run a read or dry run on a linked app, such as kv.list or content.publish with dryRun: true. See list_operations for inputs. The app refuses changes: use run_operation for comments.reply and comments.resolve, and run_destructive_operation for any other change.",
  input: z.object({
    id: z.string().describe("The app id from list_apps"),
    operation: z.string().describe("The operation name from list_operations, such as kv.list"),
    input: z.record(z.string(), z.unknown()).optional().describe("The input of the operation"),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  handler: async ({ id, input, operation }, { caller }) => projectOperation(caller, id, operation, input ?? {}, { readOnly: true }),
})
