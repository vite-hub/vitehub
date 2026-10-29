import { toEventRequest } from "@vite-hub/internal/runtime/h3-v1-request"
import { getViteHubMcpTools } from "@vite-hub/internal/runtime/mcp-tools"

import { consoleAccessAllows, consoleAccessWrites, readConsoleAccessUser, withConsoleAccess } from "./access.ts"
import { serveMcp } from "./mcp-protocol.ts"
import { getConsoleSections } from "./sections.ts"

import type { H3Event } from "h3"
import type { ConsoleAccess } from "./access.ts"
import type { McpTool } from "./mcp-protocol.ts"

const serverInfo = { name: "vitehub", title: "ViteHub MCP", version: "1" }

// Each tool says how to use it. This text stays the same for every owner package, so the Console owns no workflow.
const instructions = "ViteHub MCP gives Agents the server primitives of this app, with the Console access of the person who connects. tools/list shows only the tools of the Console sections that this person may use. Each tool description says when to use it."

/** The tools that this Console user may call: their section is installed and in the user's Console access. Each runs as that user. */
function consoleTools(access: ConsoleAccess, event: H3Event): McpTool[] {
  const installed = getConsoleSections()
  return getViteHubMcpTools()
    .filter(tool => installed.includes(tool.section) && (
      tool.annotations?.readOnlyHint === true ? consoleAccessAllows(access, tool.section) : consoleAccessWrites(access, tool.section)
    ))
    .map(tool => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
      async handler(input) {
        try {
          const user = await readConsoleAccessUser(access)
          const result = await tool.call(input, { user: user ? { ...user } : null, event })
          return {
            content: [{ type: "text", text: result.text }],
            ...(result.structured ? { structuredContent: result.structured } : {}),
            isError: result.isError === true,
          }
        }
        catch (error) {
          // A Console request error tells the Agent what to change without exposing server failures.
          const status = Number(Reflect.get(Object(error), "statusCode"))
          if (status >= 400 && status < 500 && error instanceof Error) {
            const statusMessage = Reflect.get(error, "statusMessage")
            return { content: [{ type: "text", text: typeof statusMessage === "string" ? statusMessage : error.message }], isError: true }
          }
          console.error(`[vitehub] ViteHub MCP tool ${tool.name} failed:`, error)
          return { content: [{ type: "text", text: `${tool.name} failed on the server.` }], isError: true }
        }
      },
    }))
}

/**
 * `POST /_vitehub/mcp`: ViteHub MCP, a stateless Streamable HTTP MCP server. It runs with the Console access of the
 * request, and lists the tools of the Console sections that the person may use, such as Comments.
 */
const handler: (event: H3Event) => Promise<Response> = withConsoleAccess(
  // Nuxt 4's H3 1 events carry Node's request, which `toEventRequest` reads as a web Request.
  (event: H3Event, access: ConsoleAccess) => serveMcp(toEventRequest(event), { serverInfo, instructions, tools: consoleTools(access, event) }),
  { anySection: true, user: true },
)
export default handler
