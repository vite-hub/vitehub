import {
  defineCapability,
} from "../capability-runtime.ts"
import { ViteHubError } from "@vite-hub/runtime"
import { loadAiSdk } from "../internal/ai-sdk-runtime.ts"

import type {
  AgentCapabilityDefinition,
  AgentCapabilityRuntimeContext,
  AgentRuntimeConfig,
  AgentToolDefinition,
  AgentToolSet,
} from "../types.ts"
import type { McpCapabilityOptions, McpClient, McpClientConfig, McpServerConfig, McpToolFingerprints } from "../mcp/types.ts"
import type { WorkspaceName } from "@vite-hub/workspace"

interface McpToolDrift {
  added: string[]
  changed: string[]
  removed: string[]
}

function mcpToolDefinitionDriftError(server: string, drift: McpToolDrift) {
  const summarize = (names: string[]) => names.slice(0, 12).map(name => name.slice(0, 128))
  const publicDrift = {
    added: summarize(drift.added),
    changed: summarize(drift.changed),
    removed: summarize(drift.removed),
  }
  const format = (names: string[], total: number) => names.length
    ? `${names.map(name => JSON.stringify(name)).join(", ")}${total > names.length ? `, and ${total - names.length} more` : ""}`
    : "none"
  const publicServer = server.slice(0, 256)
  return new ViteHubError("MCP_TOOL_DEFINITION_DRIFT", `[vitehub] MCP tool-definition drift for server "${publicServer}". Added: ${format(publicDrift.added, drift.added.length)}. Changed: ${format(publicDrift.changed, drift.changed.length)}. Removed: ${format(publicDrift.removed, drift.removed.length)}. Review the server tools before updating mcp({ integrity }).`, {
    details: { server: publicServer, ...publicDrift },
  })
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
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
  const runtime = await import("@ai-sdk/mcp")
  return await runtime.createMCPClient(config as never)
}

async function assertMcpToolIntegrity(server: string, tools: Record<string, unknown>, baseline: McpToolFingerprints): Promise<void> {
  const aiSdk = await loadAiSdk()
  if (typeof aiSdk.fingerprintTools !== "function" || typeof aiSdk.detectToolDrift !== "function") {
    throw new TypeError("[vitehub] mcp({ integrity }) requires ai 7.0.19 or newer.")
  }
  const current = await aiSdk.fingerprintTools(tools as never)
  const drift = aiSdk.detectToolDrift(current, baseline)
  if (drift.added.length || drift.changed.length) {
    throw mcpToolDefinitionDriftError(server, drift)
  }
}

function assertMcpIntegrityOptions(options: McpCapabilityOptions) {
  if (options.integrity === undefined) return
  if (!isRecord(options.integrity)) {
    throw new TypeError("[vitehub] mcp({ integrity }) requires fingerprint maps keyed by configured server name.")
  }
  for (const [server, fingerprints] of Object.entries(options.integrity)) {
    if (!Object.hasOwn(options.servers, server)) {
      throw new TypeError(`[vitehub] mcp({ integrity }) references unknown server "${server}".`)
    }
    if (!isRecord(fingerprints) || Object.values(fingerprints).some(value => typeof value !== "string")) {
      throw new TypeError(`[vitehub] mcp({ integrity }) requires a tool fingerprint map for server "${server}".`)
    }
  }
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
  assertMcpIntegrityOptions(options)
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
        if (options.integrity && Object.hasOwn(options.integrity, serverName)) {
          await assertMcpToolIntegrity(serverName, serverTools, options.integrity[serverName])
        }
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
  McpToolFingerprints,
} from "../mcp/types.ts"
