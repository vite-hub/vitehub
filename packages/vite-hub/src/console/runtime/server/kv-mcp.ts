import * as v from "valibot"
import type { OperationRegistry } from "@vite-hub/internal/operations"
import type { ViteHubMcpTool } from "@vite-hub/internal/runtime/mcp-tools"
import { mcpListInput, mcpListOperation, mcpListSchema, mcpResult } from "./mcp-input.ts"
import { consoleRequestError } from "./request.ts"

const pageSchema = v.object({
  cursor: v.optional(v.string()), keys: v.array(v.string()), limit: v.number(), prefix: v.string(), store: v.string(), stores: v.array(v.string()),
})

export function kvMcpTools(registry: OperationRegistry): ViteHubMcpTool[] {
  return [{
    name: "kv_list_keys",
    title: "List KV keys",
    description: "List keys in a Console KV store. Returns a page and its cursor, without values.",
    section: "kv",
    annotations: { readOnlyHint: true },
    inputSchema: mcpListSchema(500),
    async call(input) {
      const result = await mcpListOperation(registry, "kv", mcpListInput(input, 500, 200))
      if (!result.ok) {
        // These errors come from owner input checks. Provider error messages never reach MCP.
        if (["KV_STORE_NOT_FOUND", "KV_DISABLED", "KV_INVALID_INPUT"].includes(result.code)) throw consoleRequestError(result.status, result.message)
        const expired = Boolean(input.cursor) && result.code === "KV_INVALID_CURSOR"
        return {
          text: expired ? "The cursor expired. List again without a cursor." : "KV listing failed.",
          ...(expired ? { structured: { errorCode: "cursor_expired" } } : {}),
          isError: true,
        }
      }
      return mcpResult(v.parse(pageSchema, result.value))
    },
  }]
}
