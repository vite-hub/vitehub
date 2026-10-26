import type { ViteHubMcpTool } from "@vite-hub/internal/runtime/mcp-tools"
import { listConsoleBlobs } from "./blob.get.ts"
import { mcpListQuery, mcpListSchema, mcpResult } from "./mcp-input.ts"

export function blobMcpTools(): ViteHubMcpTool[] {
  return [{
    name: "blob_list_objects",
    title: "List Blob objects",
    description: "List object names, sizes, content types, and upload dates in a Console Blob store. No bytes, URLs, or custom metadata.",
    section: "blob",
    annotations: { readOnlyHint: true },
    inputSchema: mcpListSchema(250),
    async call(input) {
      const page = await listConsoleBlobs(mcpListQuery(input, 250))
      return mcpResult({
        ...page,
        blobs: page.blobs.map(({ pathname, size, contentType, uploadedAt }) => ({ pathname, size, contentType, uploadedAt })),
      })
    },
  }]
}
