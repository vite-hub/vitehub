import { ViteHubError } from "@vite-hub/runtime"

import { connectionMcpServerConfig, mcpClientConfig, resolveMcpToolServer, withMcpInitializationCompatibility } from "./internal/mcp-tool-capability.ts"
import { hasRuntimeType, isRuntimeRecord } from "./internal/runtime-type.ts"

import type { MCPClientConfig as AiSdkMcpClientConfig } from "@ai-sdk/mcp"
import type { McpClient, McpClientConfig, McpConnectionServerConfig } from "./mcp/types.ts"
import type { MaybePromise } from "./types.ts"

export type RemoteMcpServerTransport = "http" | "sse"

export interface RemoteMcpServerOptions extends Omit<Extract<AiSdkMcpClientConfig["transport"], { type: "http" | "sse" }>, "type"> {
  type?: RemoteMcpServerTransport
}

export function remoteMcpServer(options: RemoteMcpServerOptions): McpClientConfig {
  return {
    transport: {
      ...options,
      type: options.type || "http",
    },
  }
}

/**
 * A server entry accepted by `mcp({ servers })` that does not need the Agent capability context.
 * A `connection` is used as the `server` actor.
 */
export type CallMcpToolServer =
  | McpClient
  | McpClientConfig
  | McpConnectionServerConfig
  | (() => MaybePromise<McpClient | McpClientConfig | McpConnectionServerConfig>)

export interface CallMcpToolOptions {
  /** Repeat a failed call this many more times, after 100 ms, then 200 ms, and so on. Default: `0`. */
  retries?: number
  signal?: AbortSignal
  timeout?: number
}

const invalidServerMessage = "[vitehub] callMcpTool() requires an MCP client, an MCP client config, or a function that returns one."

function normalizeMcpCallError(error: unknown): Error {
  try {
    if (error instanceof Error) return error
  }
  catch {}
  let message = "[vitehub] MCP tool call failed."
  try {
    message = String(error)
  }
  catch {}
  return new Error(message, { cause: error })
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text)
  }
  catch {
    return text
  }
}

function toolResultText(content: unknown): string | undefined {
  if (!Array.isArray(content) || !content.length) return
  const texts: string[] = []
  for (const part of content) {
    if (!isRuntimeRecord(part) || part.type !== "text" || !hasRuntimeType(part.text, "string")) return
    texts.push(part.text)
  }
  return texts.join("\n")
}

function toolResultValue(name: string, result: unknown): unknown {
  if (!isRuntimeRecord(result)) return result
  const text = toolResultText(result.content)
  if (result.isError === true) {
    throw new ViteHubError("MCP_TOOL_CALL_FAILED", `[vitehub] MCP tool "${name}" failed${text ? `: ${text.slice(0, 1000)}` : "."}`, {
      details: { tool: name },
    })
  }
  if (result.structuredContent !== undefined) return result.structuredContent
  // Servers on the 2024-10-07 protocol return toolResult instead of content.
  if ("toolResult" in result) return result.toolResult
  if (text !== undefined) return parseJsonText(text)
  return result.content
}

async function callResolvedMcpTool(client: McpClient, name: string, args: Record<string, unknown>, options: CallMcpToolOptions): Promise<unknown> {
  const controller = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  const timer = options.timeout === undefined ? undefined : setTimeout(() => {
    controller.abort(new DOMException(`[vitehub] MCP tool "${name}" timed out.`, "TimeoutError"))
  }, options.timeout)
  let onAbort: () => void = () => {}
  try {
    signal.throwIfAborted()
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason)
      signal.addEventListener("abort", onAbort, { once: true })
    })
    const execute = async () => {
      const requestOptions = { signal, timeout: options.timeout }
      if ("callTool" in client && hasRuntimeType(client.callTool, "function")) {
        // Discovery prepares the SDK's HTTP parameter-header bindings.
        if ("listTools" in client && hasRuntimeType(client.listTools, "function")) {
          await client.listTools({ options: requestOptions })
        }
        else {
          await client.tools()
        }
        signal.throwIfAborted()
        return await client.callTool({ name, arguments: args, options: requestOptions })
      }
      const tool = (await client.tools())[name]
      signal.throwIfAborted()
      if (!isRuntimeRecord(tool) || !hasRuntimeType(tool.execute, "function")) {
        throw new ViteHubError("MCP_TOOL_NOT_FOUND", `[vitehub] MCP tool "${name}" is not available.`, { details: { tool: name } })
      }
      return await tool.execute(args, { abortSignal: signal, messages: [], toolCallId: crypto.randomUUID() })
    }
    return await Promise.race([execute(), aborted])
  }
  finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", onAbort)
  }
}

function isMcpServerConfig(value: McpClient | McpClientConfig | McpConnectionServerConfig): value is McpClientConfig | McpConnectionServerConfig {
  return isRuntimeRecord(value) && !(hasRuntimeType(value.tools, "function") && hasRuntimeType(value.close, "function"))
}

/** Resolve a server config that names a Connection as the `server` actor, like `mcp({ servers })` does for an Agent. */
async function serverMcpConnection(config: McpConnectionServerConfig | (McpClientConfig & { connection: string })): Promise<McpClientConfig> {
  const { getConnectionsRuntime } = await import("@vite-hub/connections/server")
  const runtime = getConnectionsRuntime()
  const name = config.connection
  const client = runtime.client(name, { rejectApprovals: true })
  return await connectionMcpServerConfig(name, config, {
    endpoint: async () => (await runtime.definition(name)).provider.mcp,
    fetch: client.fetch,
    name,
  })
}

/** The MCP client or client config for a server entry, without the ViteHub server options. */
async function callMcpToolServerConfig(connection: McpClient | McpClientConfig | McpConnectionServerConfig, name: string): Promise<McpClient | McpClientConfig> {
  // An invalid entry goes on to resolveMcpToolServer(), which rejects it with the documented message.
  if (!isMcpServerConfig(connection)) return connection
  if (Array.isArray(connection.tools) && !connection.tools.includes(name)) {
    throw new ViteHubError("MCP_TOOL_NOT_FOUND", `[vitehub] MCP tool "${name}" is not in the server's tools.`, { details: { tool: name } })
  }
  if (hasRuntimeType(connection.connection, "string")) return await serverMcpConnection({ ...connection, connection: connection.connection })
  // SAFETY: A config without a Connection must name its own transport, like an `mcp({ servers })` entry.
  return mcpClientConfig(connection as McpClientConfig)
}

/**
 * Call one tool on an MCP server outside an Agent invocation.
 * Pass the same value as an `mcp({ servers })` entry. The call opens a client, sends
 * `tools/call`, and closes the client again. Streamable HTTP servers can answer with
 * JSON or with Server-Sent Events. A `connection` entry uses the Connection as the `server` actor.
 *
 * Returns `[null, value]`, where `value` is the tool's `structuredContent`, or its text
 * content parsed as JSON when possible. Returns `[error, null]` when the server cannot be
 * reached or the tool reports an error.
 *
 * `retries` repeats a failed call that many more times, after 100 ms, then 200 ms, and so on.
 * It stops when `signal` aborts, and returns the last error.
 */
export async function callMcpTool(
  server: CallMcpToolServer,
  name: string,
  args: Record<string, unknown> = {},
  options: CallMcpToolOptions = {},
): Promise<[null, unknown] | [Error, null]> {
  const retries = options.retries ?? 0
  if (!Number.isInteger(retries) || retries < 0) {
    throw new TypeError("[vitehub] callMcpTool({ retries }) must be a non-negative integer.")
  }
  for (let attempt = 0; ; attempt++) {
    const result = await callMcpToolOnce(server, name, args, options)
    if (!result[0] || attempt >= retries || options.signal?.aborted) return result
    await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)))
    if (options.signal?.aborted) return result
  }
}

async function callMcpToolOnce(
  server: CallMcpToolServer,
  name: string,
  args: Record<string, unknown>,
  options: CallMcpToolOptions,
): Promise<[null, unknown] | [Error, null]> {
  let client: McpClient | undefined
  let owned = false
  try {
    const connection = await callMcpToolServerConfig(hasRuntimeType(server, "function") ? await server() : server, name)
    const resolved = await resolveMcpToolServer(
      { connection: withMcpInitializationCompatibility(connection), owned: hasRuntimeType(server, "function") },
      invalidServerMessage,
      async (config) => {
        const { createMCPClient } = await import("@ai-sdk/mcp")
        if (!options.signal) return await createMCPClient(config)
        const initializationSignal = config.initializationOptions?.signal
        const signal = initializationSignal
          ? AbortSignal.any([options.signal, initializationSignal])
          : options.signal
        signal.throwIfAborted()
        return await createMCPClient({
          ...config,
          initializationOptions: { ...config.initializationOptions, signal },
        })
      },
    )
    client = resolved.client
    owned = resolved.owned
    const result = await callResolvedMcpTool(client, name, args, options)
    return [null, toolResultValue(name, result)]
  }
  catch (error) {
    return [normalizeMcpCallError(error), null]
  }
  finally {
    // A close failure must not replace the tool result or the original error.
    if (owned) await Promise.resolve().then(() => client?.close()).catch(() => {})
  }
}

export type {
  MCPClient,
  MCPTransport,
} from "@ai-sdk/mcp"
export type { McpClientConfig as MCPClientConfig } from "./mcp/types.ts"
