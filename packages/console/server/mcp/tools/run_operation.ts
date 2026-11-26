import { HTTPError } from "h3"
import { isPromptFreeMcpWrite } from "@vite-hub/internal/operations"
import { defineMcpTool } from "vite-hub/mcp"
import { z } from "zod"

import { projectOperation } from "../../utils/mcp.ts"

export default defineMcpTool({
  title: "Run an operation",
  description: "Run comments.reply or comments.resolve on a linked app without confirmation. Use read_operation for reads and dry runs, and run_destructive_operation for every other change. After you make the change that a comment thread asks for, resolve it with a reply that says what changed, such as the commit or a link. Resolve all handled threads in one call, with { threads: [{ threadId, reply }] }.",
  input: z.object({
    id: z.string().describe("The app id from list_apps"),
    operation: z.string().describe("comments.reply or comments.resolve"),
    input: z.record(z.string(), z.unknown()).optional().describe("The input of the operation"),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  handler: async ({ id, input, operation }, { caller }) => {
    if (!isPromptFreeMcpWrite(operation)) {
      throw new HTTPError({ message: "run_operation only runs comments.reply and comments.resolve. Use read_operation for reads and dry runs. For other changes, explain the change and use run_destructive_operation with confirm: true after the user agrees.", status: 400 })
    }
    return projectOperation(caller, id, operation, input ?? {})
  },
})
