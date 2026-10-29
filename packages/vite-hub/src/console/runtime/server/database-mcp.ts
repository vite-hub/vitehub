import type { ViteHubMcpTool } from "@vite-hub/internal/runtime/mcp-tools"
import { getConsoleDatabase } from "./database.ts"
import { consoleDatabaseSchema } from "./database.get.ts"
import { mcpResult } from "./mcp-input.ts"
import { consoleRequestError } from "./request.ts"

export function databaseMcpTools(): ViteHubMcpTool[] {
  return [
    {
      name: "database_list_databases",
      title: "List databases",
      description: "List the Database names installed in the Console. No connection settings or rows.",
      section: "databases",
      annotations: { readOnlyHint: true },
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async call() {
        return mcpResult({ databases: [...getConsoleDatabase().names] })
      },
    },
    {
      name: "database_get_schema",
      title: "Read database schema",
      description: "List tables, columns, and relationships for a Console Database. Does not query rows.",
      section: "databases",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: { database: { type: "string", description: "A name from database_list_databases. Defaults to the first Database." } },
        additionalProperties: false,
      },
      async call(input) {
        if (input.database !== undefined && typeof input.database !== "string") throw consoleRequestError(400, "database must be a string.")
        const { requestedDatabase, metadata } = consoleDatabaseSchema(input.database ?? null)
        return mcpResult({ database: requestedDatabase, ...metadata })
      },
    },
  ]
}
