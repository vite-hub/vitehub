import {
  defineCapability,
} from "../capability-runtime.ts"

import type {
  AgentCapabilityDefinition,
  AgentCapabilityRuntimeContext,
  AgentRuntimeConfig,
  AgentToolDefinition,
  AgentToolSet,
} from "../types.ts"
import type { McpCapabilityOptions, McpClient, McpClientConfig, McpServerConfig } from "../mcp/types.ts"
import type { WorkspaceName } from "@vite-hub/workspace"

function normalizeMcpToolName(serverName: string, toolName: string) {
  return `mcp_${serverName}_${toolName}`.replace(/[^a-zA-Z0-9_]/g, "_")
}

function isMcpClient(value: unknown): value is McpClient {
  return typeof value === "object"
    && value !== null
    && typeof (value as { tools?: unknown }).tools === "function"
    && typeof (value as { close?: unknown }).close === "function"
}

function isMcpClientConfig(value: unknown): value is McpClientConfig {
  return typeof value === "object"
    && value !== null
    && "transport" in value
}

const secretKeyPattern = /authorization|api[-_ ]?key|cookie|secret|token|password|credential/i

function sanitizeMcpMetadata(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "function") return "[function]"
  if (!value || typeof value !== "object") return value
  if (seen.has(value)) return "[circular]"
  seen.add(value)
  if (Array.isArray(value)) return value.map(item => sanitizeMcpMetadata(item, seen))
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = secretKeyPattern.test(key) ? "[redacted]" : sanitizeMcpMetadata(item, seen)
  }
  return output
}

async function createMcpClient(config: McpClientConfig): Promise<McpClient> {
  const specifier = ["@ai-sdk", "mcp"].join("/")
  const runtime = await import(specifier) as typeof import("@ai-sdk/mcp")
  return await runtime.createMCPClient(config as never)
}

async function resolveMcpClient<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  server: McpServerConfig<TRuntimeConfig, Name>,
  context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>,
): Promise<{ client: McpClient, metadata: unknown }> {
  const resolved = typeof server === "function" ? await server(context) : server
  if (isMcpClient(resolved)) {
    return {
      client: resolved,
      metadata: {
        client: true,
        serverInfo: sanitizeMcpMetadata(resolved.serverInfo),
      },
    }
  }
  if (isMcpClientConfig(resolved)) {
    return {
      client: await createMcpClient(resolved),
      metadata: sanitizeMcpMetadata(resolved),
    }
  }
  throw new TypeError("[vitehub] mcp({ servers }) entries must resolve to an MCP client or MCP client config.")
}

export function mcp<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
>(options: McpCapabilityOptions<TRuntimeConfig, Name>): AgentCapabilityDefinition<TRuntimeConfig, Name> {
  if (!options || typeof options !== "object" || !options.servers || typeof options.servers !== "object") {
    throw new TypeError("[vitehub] mcp({ servers }) requires a server map.")
  }
  const clientsByContext = new WeakMap<AgentCapabilityRuntimeContext<TRuntimeConfig, Name>, McpClient[]>()
  return defineCapability({
    id: "mcp",
    metadata: { servers: sanitizeMcpMetadata(options.servers) as Record<string, unknown> },
    async resolve(context) {
      const tools: AgentToolSet = {}
      const clients: McpClient[] = []
      clientsByContext.set(context, clients)
      for (const [serverName, server] of Object.entries(options.servers)) {
        const { client, metadata } = await resolveMcpClient(server, context)
        clients.push(client)
        const serverTools = await client.tools()
        for (const [toolName, tool] of Object.entries(serverTools || {})) {
          const definition = tool as AgentToolDefinition & { metadata?: Record<string, unknown> }
          const name = normalizeMcpToolName(serverName, toolName)
          if (tools[name]) {
            throw new Error(`[vitehub] Duplicate MCP tool name "${name}" after normalization.`)
          }
          tools[name] = {
            ...definition,
            metadata: {
              ...definition.metadata,
              mcp: metadata,
              mcpServer: serverName,
              originalName: toolName,
            },
            name,
          }
        }
      }
      context.tools.add(tools)
    },
    async close(context) {
      const clients = clientsByContext.get(context) || []
      clientsByContext.delete(context)
      for (const client of clients.splice(0).reverse()) {
        await client.close()
      }
    },
  })
}

export type {
  McpCapabilityOptions,
  McpClient,
  McpClientConfig,
  McpServerConfig,
} from "../mcp/types.ts"
