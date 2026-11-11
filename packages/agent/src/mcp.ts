import { defineErrors, getViteHubErrorShape, ViteHubError } from "@vite-hub/runtime"

import { connectionMcpServerConfig, mcpClientConfig, resolveMcpToolServer, withMcpInitializationCompatibility } from "./internal/mcp-tool-capability.ts"
import { isRuntimeRecord } from "./internal/runtime-type.ts"

import type { Result, ResultError } from "@vite-hub/runtime"
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

// Errors that `callMcpTool()` returns as `[error, undefined]`. Each code has a heading on the docs page.
const mcpToolErrors = /*#__PURE__*/ defineErrors({
  docs: "https://vitehub.dev/docs/agents/diagnostics",
  codes: {
    MCP_SERVER_FAILED: {
      why: ({ tool }: { tool: string }) => `The MCP server could not run tool "${tool}".`,
      fix: "Read `error.cause` for the connection or server error. Retry when the server is available, or pass `retries`.",
    },
    MCP_TOOL_CALL_FAILED: {
      why: ({ text, tool }: { text?: string, tool: string }) => `MCP tool "${tool}" reported an error${text ? `: ${text.slice(0, 1000)}` : "."}`,
      fix: "Read the tool's message in `error.why`, then change the arguments or retry.",
    },
    MCP_TOOL_CANCELLED: {
      why: ({ tool }: { tool: string }) => `The call to MCP tool "${tool}" was cancelled by \`signal\`.`,
      fix: "`error.cause` is the abort reason. Call the tool again with a signal that is not aborted.",
    },
    MCP_TOOL_NOT_FOUND: {
      why: ({ tool }: { tool: string }) => `MCP tool "${tool}" is not available on the server, or not in the \`tools\` of the server entry.`,
      fix: "Check the tool name. When the server entry lists `tools`, add the tool to it.",
    },
    MCP_TOOL_TIMEOUT: {
      why: ({ timeout, tool }: { timeout: number, tool: string }) => `MCP tool "${tool}" did not answer within ${timeout} ms.`,
      fix: "Raise `timeout`, or pass `retries` to call the tool again.",
    },
  },
})

/** Codes of the errors that `callMcpTool()` returns. */
export type CallMcpToolErrorCode = "MCP_SERVER_FAILED" | "MCP_TOOL_CALL_FAILED" | "MCP_TOOL_CANCELLED" | "MCP_TOOL_NOT_FOUND" | "MCP_TOOL_TIMEOUT"

function isTimeout(error: unknown): boolean {
  try {
    return error instanceof DOMException && error.name === "TimeoutError"
  }
  catch {
    return false
  }
}

function callMcpToolError(error: unknown, name: string, options: CallMcpToolOptions): ResultError<CallMcpToolErrorCode> {
  if (getViteHubErrorShape(error)?.code === "MCP_TOOL_NOT_FOUND") return mcpToolErrors.MCP_TOOL_NOT_FOUND({ cause: error, tool: name })
  if (options.signal?.aborted) return mcpToolErrors.MCP_TOOL_CANCELLED({ cause: error, tool: name })
  if (options.timeout !== undefined && isTimeout(error)) return mcpToolErrors.MCP_TOOL_TIMEOUT({ cause: error, timeout: options.timeout, tool: name })
  return mcpToolErrors.MCP_SERVER_FAILED({ cause: error, tool: name })
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
    if (!isRuntimeRecord(part) || part.type !== "text" || typeof part.text !== "string") return
    texts.push(part.text)
  }
  return texts.join("\n")
}

function toolResult(result: unknown): { isError: true, text: string | undefined } | { isError: false, value: unknown } {
  if (!isRuntimeRecord(result)) return { isError: false, value: result }
  const text = toolResultText(result.content)
  if (result.isError === true) return { isError: true, text }
  if (result.structuredContent !== undefined) return { isError: false, value: result.structuredContent }
  // Servers on the 2024-10-07 protocol return toolResult instead of content.
  if ("toolResult" in result) return { isError: false, value: result.toolResult }
  if (text !== undefined) return { isError: false, value: parseJsonText(text) }
  return { isError: false, value: result.content }
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
      if ("callTool" in client && typeof client.callTool === "function") {
        // Discovery prepares the SDK's HTTP parameter-header bindings.
        let found = false
        if ("listTools" in client && typeof client.listTools === "function") {
          let cursor: string | undefined
          do {
            const listing: unknown = await client.listTools({ options: requestOptions, params: cursor === undefined ? undefined : { cursor } })
            signal.throwIfAborted()
            if (!isRuntimeRecord(listing) || !Array.isArray(listing.tools)) {
              throw new TypeError("[vitehub] MCP tools/list must return a tools array.")
            }
            found = listing.tools.some((tool: unknown) => isRuntimeRecord(tool) && tool.name === name)
            cursor = typeof listing.nextCursor === "string" ? listing.nextCursor : undefined
          } while (!found && cursor !== undefined)
        }
        else {
          found = Object.hasOwn(await client.tools(), name)
        }
        signal.throwIfAborted()
        if (!found) {
          throw new ViteHubError("MCP_TOOL_NOT_FOUND", `[vitehub] MCP tool "${name}" is not available.`, { details: { tool: name } })
        }
        return await client.callTool({ name, arguments: args, options: requestOptions })
      }
      const tool = (await client.tools())[name]
      signal.throwIfAborted()
      if (!isRuntimeRecord(tool) || typeof tool.execute !== "function") {
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
  return isRuntimeRecord(value) && !(typeof value.tools === "function" && typeof value.close === "function")
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
  if (typeof connection.connection === "string") return await serverMcpConnection({ ...connection, connection: connection.connection })
  // SAFETY: A config without a Connection must name its own transport, like an `mcp({ servers })` entry.
  return mcpClientConfig(connection as McpClientConfig)
}

/**
 * Call one tool on an MCP server outside an Agent invocation.
 * Pass the same value as an `mcp({ servers })` entry. The call opens a client, sends
 * `tools/call`, and closes the client again. Streamable HTTP servers can answer with
 * JSON or with Server-Sent Events. A `connection` entry uses the Connection as the `server` actor.
 *
 * Returns `[undefined, value]`, where `value` is the tool's `structuredContent`, or its text
 * content parsed as JSON when possible. Returns `[error, undefined]` when the server cannot be
 * reached, the tool reports an error, the call times out, or `signal` aborts.
 *
 * `retries` repeats a failed call that many more times, after 100 ms, then 200 ms, and so on.
 * It stops when `signal` aborts, and returns the last error.
 */
export async function callMcpTool(
  server: CallMcpToolServer,
  name: string,
  args: Record<string, unknown> = {},
  options: CallMcpToolOptions = {},
): Promise<Result<unknown, CallMcpToolErrorCode>> {
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
): Promise<Result<unknown, CallMcpToolErrorCode>> {
  let client: McpClient | undefined
  let owned = false
  try {
    const connection = await callMcpToolServerConfig(typeof server === "function" ? await server() : server, name)
    const resolved = await resolveMcpToolServer(
      { connection: withMcpInitializationCompatibility(connection), owned: typeof server === "function" },
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
    const tool = toolResult(result)
    if (tool.isError) return [mcpToolErrors.MCP_TOOL_CALL_FAILED({ text: tool.text, tool: name }), undefined]
    return [undefined, tool.value]
  }
  catch (error) {
    return [callMcpToolError(error, name, options), undefined]
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
