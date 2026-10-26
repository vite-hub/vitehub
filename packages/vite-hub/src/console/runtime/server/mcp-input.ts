import type { ViteHubMcpInputSchema, ViteHubMcpToolResult } from "@vite-hub/internal/runtime/mcp-tools"
import { consoleRequestError } from "./request.ts"

/** Only declared list parameters reach the Console reader. */
export function mcpListQuery(input: Record<string, unknown>, maximum: number): URLSearchParams {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(input)) {
    if (key === "limit") {
      if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > maximum) throw consoleRequestError(400, `limit must be an integer from 1 to ${maximum}.`)
    }
    else if (!["store", "prefix", "cursor"].includes(key) || typeof value !== "string") {
      throw consoleRequestError(400, "Use only store, prefix, cursor, and limit.")
    }
    query.set(key, String(value))
  }
  return query
}

export function mcpResult(value: Record<string, unknown>): ViteHubMcpToolResult {
  return { text: JSON.stringify(value), structured: value }
}

export function mcpListSchema(maximum: number): ViteHubMcpInputSchema {
  return {
    type: "object" as const,
    properties: {
      store: { type: "string", description: "A Console store name. Default: default." },
      prefix: { type: "string" },
      cursor: { type: "string", description: "The cursor from the previous page." },
      limit: { type: "integer", minimum: 1, maximum },
    },
    additionalProperties: false,
  }
}
