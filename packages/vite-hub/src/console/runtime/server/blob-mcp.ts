import * as v from "valibot"
import type { OperationRegistry } from "@vite-hub/internal/operations"
import type { ViteHubMcpTool } from "@vite-hub/internal/runtime/mcp-tools"
import { mcpListInput, mcpListOperation, mcpListSchema, mcpResult } from "./mcp-input.ts"
import { consoleRequestError } from "./request.ts"

const pageSchema = v.object({
  blobs: v.array(v.object({ pathname: v.string(), size: v.optional(v.number()), contentType: v.optional(v.string()), uploadedAt: v.string() })),
  cursor: v.optional(v.string()), hasMore: v.boolean(), limit: v.number(), prefix: v.string(), store: v.string(), stores: v.array(v.string()),
})

export function blobMcpTools(registry: OperationRegistry): ViteHubMcpTool[] {
  return [{
    name: "blob_list_objects",
    title: "List Blob objects",
    description: "List object names, sizes, content types, and upload dates in a Console Blob store. No bytes, URLs, or custom metadata.",
    section: "blob",
    annotations: { readOnlyHint: true },
    inputSchema: mcpListSchema(250),
    async call(input) {
      const result = await mcpListOperation(registry, "blob", mcpListInput(input, 250, 100))
      if (!result.ok) {
        if (["BLOB_STORE_NOT_FOUND", "BLOB_DISABLED", "BLOB_INVALID_INPUT"].includes(result.code)) throw consoleRequestError(result.status, result.message)
        return { text: "Blob listing failed.", isError: true }
      }
      // Parse an allowlist so URLs, custom metadata, and HTTP metadata cannot reach the Agent.
      return mcpResult(v.parse(pageSchema, result.value))
    },
  }]
}
