import * as v from "valibot"

import { consoleAppAuthBasePath } from "./access.ts"
import { defineConsoleOperation } from "./operations.ts"
import { consoleRequestError } from "./request.ts"

import type { AnyOperation } from "@vite-hub/internal/operations"
import type { ConsoleMcpCaller } from "./mcp-client.ts"

const id = v.pipe(v.string(), v.minLength(1), v.maxLength(64))
const optionalText = v.optional(v.pipe(v.string(), v.maxLength(4_096)))
const prompt = v.optional(v.picklist(["login"]))
const listKind = v.picklist(["prompts", "resource-templates", "resources", "tools"])

/**
 * The MCP grants of the Console belong to the person who signed in to it. Agents and MCP clients of the app's own
 * operations cannot drive them. The CLI of `vite dev` uses them as the local developer.
 */
function caller(context: { access: ConsoleMcpCaller["access"], request?: Request, surface: string }): ConsoleMcpCaller {
  if (context.surface !== "console" && context.surface !== "cli") {
    throw consoleRequestError(403, "MCP connections of the Console belong to the person who opened the Console. Agents cannot use them.")
  }
  return { access: context.access, ...(context.request ? { request: context.request } : {}) }
}

const server = () => import("./mcp-client.ts")

const mcpList = defineConsoleOperation({
  description: "List your MCP connections and the MCP servers that this app announces.",
  input: v.strictObject({}),
  kind: "read",
  name: "mcp-client.list",
  run: async (_input, context) => {
    const shared = context.request ? consoleAppAuthBasePath({ req: context.request }) : undefined
    shared?.catch(() => {})
    return (await server()).listConsoleMcp(caller(context), { sharedSession: shared !== undefined })
  },
  section: "mcp-client",
})

const mcpConnect = defineConsoleOperation({
  cli: { positional: ["server"] },
  description: "Connect to an MCP server. Without a token, a server that asks for credentials starts the OAuth sign-in.",
  input: v.strictObject({
    label: v.optional(v.pipe(v.string(), v.maxLength(80))),
    prompt,
    server: v.pipe(v.string(), v.minLength(1), v.maxLength(2_048)),
    token: optionalText,
  }),
  kind: "write",
  name: "mcp-client.connect",
  run: async (input, context) => (await server()).connectConsoleMcp(caller(context), input),
  section: "mcp-client",
})

const mcpComplete = defineConsoleOperation({
  description: "Finish the OAuth sign-in that an authorization server redirected back from.",
  input: v.strictObject({
    code: optionalText,
    error: v.optional(v.pipe(v.string(), v.maxLength(200))),
    errorDescription: optionalText,
    iss: optionalText,
    state: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  }),
  kind: "write",
  name: "mcp-client.complete",
  run: async (input, context) => (await server()).completeConsoleMcp(caller(context), input),
  section: "mcp-client",
})

const mcpReconnect = defineConsoleOperation({
  cli: { positional: ["id"] },
  description: "Sign in to an MCP connection again, or open a new MCP session.",
  input: v.strictObject({ id, prompt }),
  kind: "write",
  name: "mcp-client.reconnect",
  run: async (input, context) => (await server()).reconnectConsoleMcp(caller(context), input),
  section: "mcp-client",
})

const mcpDisconnect = defineConsoleOperation({
  cli: { positional: ["id"] },
  description: "End the MCP session of a connection, revoke its OAuth tokens, and forget it.",
  input: v.strictObject({ id }),
  kind: "write",
  name: "mcp-client.disconnect",
  run: async (input, context) => (await server()).disconnectConsoleMcp(caller(context), input),
  section: "mcp-client",
})

const mcpItems = defineConsoleOperation({
  cli: { positional: ["id", "kind"] },
  description: "List the tools, resources, resource templates, or prompts of an MCP connection, one page at a time.",
  input: v.strictObject({ cursor: optionalText, id, kind: listKind }),
  kind: "read",
  name: "mcp-client.items",
  run: async (input, context) => (await server()).listConsoleMcpItems(caller(context), input),
  section: "mcp-client",
})

const mcpCall = defineConsoleOperation({
  cli: { positional: ["id", "tool"] },
  description: "Call one tool of an MCP connection and return its result, or the error of the server.",
  input: v.strictObject({ arguments: v.optional(v.record(v.string(), v.unknown())), id, tool: v.pipe(v.string(), v.minLength(1), v.maxLength(256)) }),
  kind: "write",
  maxRequestBytes: 256 * 1_024,
  name: "mcp-client.call",
  run: async (input, context) => (await server()).callConsoleMcpTool(caller(context), input),
  section: "mcp-client",
})

const mcpRead = defineConsoleOperation({
  cli: { positional: ["id", "uri"] },
  description: "Read one resource of an MCP connection.",
  input: v.strictObject({ id, uri: v.pipe(v.string(), v.minLength(1), v.maxLength(2_048)) }),
  kind: "read",
  name: "mcp-client.read",
  run: async (input, context) => (await server()).readConsoleMcpResource(caller(context), input),
  section: "mcp-client",
})

const mcpPrompt = defineConsoleOperation({
  cli: { positional: ["id", "name"] },
  description: "Get one prompt of an MCP connection with its arguments filled in.",
  input: v.strictObject({ arguments: v.optional(v.record(v.string(), v.string())), id, name: v.pipe(v.string(), v.minLength(1), v.maxLength(256)) }),
  kind: "read",
  name: "mcp-client.prompt",
  run: async (input, context) => (await server()).getConsoleMcpPrompt(caller(context), input),
  section: "mcp-client",
})

/** The operations of the MCP client section. The Console contributes them only when `console.mcpClient` is on. */
export const consoleMcpClientOperations: readonly AnyOperation[] = [mcpList, mcpConnect, mcpComplete, mcpReconnect, mcpDisconnect, mcpItems, mcpCall, mcpRead, mcpPrompt]
