import type { ViteHubMcpTool } from "@vite-hub/internal/runtime/mcp-tools"
import { listConsoleKVKeys } from "./kv.get.ts"
import { mcpListQuery, mcpListSchema, mcpResult } from "./mcp-input.ts"

export function kvMcpTools(): ViteHubMcpTool[] {
  return [{
    name: "kv_list_keys",
    title: "List KV keys",
    description: "List keys in a Console KV store. Returns a page and its cursor, without values.",
    section: "kv",
    annotations: { readOnlyHint: true },
    inputSchema: mcpListSchema(500),
    async call(input) {
      const page = await listConsoleKVKeys(mcpListQuery(input, 500))
      if (page.error) return {
        text: page.errorCode === "cursor_expired" ? "The cursor expired. List again without a cursor." : "KV listing failed.",
        ...(page.errorCode ? { structured: { errorCode: page.errorCode } } : {}),
        isError: true,
      }
      return mcpResult(page)
    },
  }]
}
