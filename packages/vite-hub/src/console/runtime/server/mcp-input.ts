import { runOperation } from "@vite-hub/internal/operations"
import type { OperationRegistry, OperationResult } from "@vite-hub/internal/operations"
import type { ViteHubMcpInputSchema, ViteHubMcpToolResult } from "@vite-hub/internal/runtime/mcp-tools"
import { consoleRequestError } from "./request.ts"

/** Only declared list parameters reach the owner operation. */
export function mcpListInput(input: Record<string, unknown>, maximum: number, defaultLimit: number): Record<string, unknown> {
  const parsed: Record<string, unknown> = { limit: defaultLimit }
  for (const [key, value] of Object.entries(input)) {
    if (key === "limit") {
      if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > maximum) throw consoleRequestError(400, `limit must be an integer from 1 to ${maximum}.`)
    }
    else if (!["store", "prefix", "cursor"].includes(key) || typeof value !== "string") {
      throw consoleRequestError(400, "Use only store, prefix, cursor, and limit.")
    }
    if (value !== "") parsed[key] = value
  }
  return parsed
}

/** The MCP route checked the section; storage operations never need the signed-in user. */
export function mcpListOperation(registry: OperationRegistry, section: "kv" | "blob", input: Record<string, unknown>): Promise<OperationResult> {
  return runOperation(registry, `${section}.list`, input, { access: { mode: "mcp", sections: [`${section}:read`] }, surface: "mcp", user: null })
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
