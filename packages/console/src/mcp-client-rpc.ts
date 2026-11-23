import { answerOperationRpc, operationRpcRefusal, readOperationRpcCall } from "@vite-hub/internal/operation-rpc"
import { z } from "zod"

import { callConsoleMcpTool, completeConsoleMcp, ConsoleMcpError, consoleMcpStateProject, connectConsoleMcp, disconnectConsoleMcp, getConsoleMcpPrompt, listConsoleMcp, listConsoleMcpItems, readConsoleMcpResource, reconnectConsoleMcp } from "./mcp-client.ts"

import type { OperationRpcReply } from "@vite-hub/internal/operation-rpc"
import type { ConsoleMcpScope } from "./mcp-client.ts"

/** The largest request body of an MCP client call: a tool call carries up to 256 KiB of arguments. */
export const consoleMcpMaxRequestBytes = 300 * 1_024

const id = z.string().min(1).max(64)
const optionalText = z.string().max(4_096).optional()
const prompt = z.literal("login").optional()

type McpOperation = (scope: ConsoleMcpScope, input: unknown) => Promise<unknown>

class InvalidInput extends Error {
  readonly status = 400
  readonly code = "CONSOLE_REQUEST_INVALID"
}

function operation<Schema extends z.ZodType>(schema: Schema, run: (scope: ConsoleMcpScope, input: z.infer<Schema>) => Promise<unknown>): McpOperation {
  return (scope, input) => {
    const parsed = schema.safeParse(input ?? {})
    if (!parsed.success) throw new InvalidInput(`The input is not valid: ${parsed.error.issues.map(issue => `${issue.path.join(".") || "input"} ${issue.message}`).join("; ").slice(0, 300)}`)
    return run(scope, parsed.data)
  }
}

const operations: Readonly<Record<string, McpOperation>> = {
  "mcp-client.call": operation(z.strictObject({ arguments: z.record(z.string(), z.unknown()).optional(), id, tool: z.string().min(1).max(256) }), callConsoleMcpTool),
  "mcp-client.complete": operation(z.strictObject({ code: optionalText, error: z.string().max(200).optional(), errorDescription: optionalText, iss: optionalText, state: z.string().min(1).max(200) }), completeConsoleMcp),
  "mcp-client.connect": operation(z.strictObject({ label: z.string().max(80).optional(), prompt, server: z.string().min(1).max(2_048), token: optionalText }), connectConsoleMcp),
  "mcp-client.disconnect": operation(z.strictObject({ id }), disconnectConsoleMcp),
  "mcp-client.items": operation(z.strictObject({ id, kind: z.enum(["prompts", "resource-templates", "resources", "tools"]) }), listConsoleMcpItems),
  "mcp-client.list": operation(z.strictObject({}), listConsoleMcp),
  "mcp-client.prompt": operation(z.strictObject({ arguments: z.record(z.string(), z.string()).optional(), id, name: z.string().min(1).max(256) }), getConsoleMcpPrompt),
  "mcp-client.read": operation(z.strictObject({ id, uri: z.string().min(1).max(2_048) }), readConsoleMcpResource),
  "mcp-client.reconnect": operation(z.strictObject({ id, prompt }), reconnectConsoleMcp),
}

function failure(error: unknown): { code: string, message: string, status: number } {
  if (error instanceof ConsoleMcpError || error instanceof InvalidInput) return { code: error.code, message: error.message, status: error.status }
  console.error("[vitehub] Console MCP client failed:", error)
  return { code: "CONSOLE_REQUEST_FAILED", message: "The MCP client of the Console failed. Try again.", status: 500 }
}

/**
 * The project that a call acts on. A sign-in comes back to the project that is open in the browser, which can be another
 * project than the one that started it, so `mcp-client.complete` acts on the project in its OAuth `state`.
 */
export function consoleMcpCallProject(body: unknown, routeProject: string): string {
  const call = readOperationRpcCall(body)
  const input: unknown = call?.m === "mcp-client.complete" ? call.a[0] : undefined
  const state: unknown = input instanceof Object ? Reflect.get(input, "state") : undefined
  return (typeof state === "string" ? consoleMcpStateProject(state) : undefined) ?? routeProject
}

/** Answer one birpc call of the MCP client section with the operations of the Console server. */
export async function answerConsoleMcpCall(body: unknown, scope: ConsoleMcpScope): Promise<OperationRpcReply> {
  const call = readOperationRpcCall(body)
  if (!call) return operationRpcRefusal({ code: "CONSOLE_REQUEST_INVALID", message: "The request is not one operation call.", status: 400 })
  return answerOperationRpc(call, {
    failure,
    operations,
    run: (selected, input) => selected(scope, input),
    unknown: name => new ConsoleMcpError(404, "CONSOLE_NOT_FOUND", `The Console has no MCP client operation ${name.slice(0, 80)}.`),
  })
}

/** The HTTP status of a reply: the status of its failure, or 200. */
export function consoleMcpReplyStatus(reply: OperationRpcReply): number {
  return "e" in reply ? reply.e.status : 200
}
