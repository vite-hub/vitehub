import { defineCapability } from "../capability-runtime.ts"
import { ViteHubError } from "@vite-hub/runtime"
import { loadAiSdk } from "./ai-sdk-runtime.ts"

import type {
  AgentCapabilityDefinition,
  AgentCapabilityRuntimeContext,
  AgentRuntimeConfig,
  AgentToolDefinition,
  AgentToolSet,
  MaybePromise,
} from "../types.ts"
import type { McpClient, McpClientConfig, McpToolFingerprints } from "../mcp/types.ts"
import type { MCPClientConfig as AiSdkMcpClientConfig } from "@ai-sdk/mcp"
import type { WorkspaceName } from "@vite-hub/workspace"

interface McpToolDrift {
  added: string[]
  changed: string[]
  removed: string[]
}

export interface ResolvedMcpToolServer {
  connection: McpClient | McpClientConfig
  integrity?: McpToolFingerprints
  owned?: boolean
}

export interface McpToolServerDefinition<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> {
  name: string
  resolve: (context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) => MaybePromise<ResolvedMcpToolServer | false | null | undefined>
}

export interface McpToolCapabilityOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> {
  id: string
  integrityLabel: string
  invalidServerMessage: string
  metadata?: Record<string, unknown>
  servers: McpToolServerDefinition<TRuntimeConfig, Name>[]
  toolName: (serverName: string, toolName: string) => string
}

function mcpToolDefinitionDriftError(server: string, drift: McpToolDrift, integrityLabel: string) {
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
  return new ViteHubError("MCP_TOOL_DEFINITION_DRIFT", `[vitehub] MCP tool-definition drift for server "${publicServer}". Added: ${format(publicDrift.added, drift.added.length)}. Changed: ${format(publicDrift.changed, drift.changed.length)}. Removed: ${format(publicDrift.removed, drift.removed.length)}. Review the server tools before updating ${integrityLabel}.`, {
    details: { server: publicServer, ...publicDrift },
  })
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

function sanitizeMetadataUrl(value: string | URL): string {
  let url: URL
  try {
    url = new URL(value)
  }
  catch {
    return String(value)
  }
  url.username = ""
  url.password = ""
  url.search = ""
  url.hash = ""
  return url.href
}

export function sanitizeMcpMetadata(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "function") return "[function]"
  if (typeof value === "string") return sanitizeMetadataUrl(value)
  if (!value || typeof value !== "object") return value
  if (value instanceof URL) return sanitizeMetadataUrl(value)
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
  return await runtime.createMCPClient(config as AiSdkMcpClientConfig)
}

async function assertMcpToolIntegrity(server: string, tools: Record<string, unknown>, baseline: McpToolFingerprints, integrityLabel: string): Promise<void> {
  const aiSdk = await loadAiSdk()
  if (typeof aiSdk.fingerprintTools !== "function" || typeof aiSdk.detectToolDrift !== "function") {
    throw new TypeError(`[vitehub] ${integrityLabel} requires ai 7.0.19 or newer.`)
  }
  const current = await aiSdk.fingerprintTools(tools as never)
  const drift = aiSdk.detectToolDrift(current, baseline)
  if (drift.added.length || drift.changed.length) {
    throw mcpToolDefinitionDriftError(server, drift, integrityLabel)
  }
}

async function resolveMcpToolServer(
  resolved: ResolvedMcpToolServer,
  invalidServerMessage: string,
): Promise<{ client: McpClient, metadata: unknown, owned: boolean }> {
  if (isMcpClient(resolved.connection)) {
    return {
      client: resolved.connection,
      metadata: {
        client: true,
        serverInfo: sanitizeMcpMetadata(resolved.connection.serverInfo),
      },
      owned: resolved.owned !== false,
    }
  }
  if (isMcpClientConfig(resolved.connection)) {
    return {
      client: await createMcpClient(resolved.connection),
      metadata: sanitizeMcpMetadata(resolved.connection),
      owned: true,
    }
  }
  throw new TypeError(invalidServerMessage)
}

export function defineMcpToolCapability<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
>(options: McpToolCapabilityOptions<TRuntimeConfig, Name>): AgentCapabilityDefinition<TRuntimeConfig, Name> {
  const clientsByContext = new WeakMap<AgentCapabilityRuntimeContext<TRuntimeConfig, Name>, McpClient[]>()
  return defineCapability({
    id: options.id,
    metadata: options.metadata,
    async resolve(context) {
      const tools: AgentToolSet = {}
      const clients: McpClient[] = []
      clientsByContext.set(context, clients)
      for (const server of options.servers) {
        const serverDefinition = await server.resolve(context)
        if (serverDefinition === false || serverDefinition === null || serverDefinition === undefined) continue
        const { client, metadata, owned } = await resolveMcpToolServer(serverDefinition, options.invalidServerMessage)
        if (owned) clients.push(client)
        const serverTools = await client.tools()
        if (serverDefinition.integrity) {
          await assertMcpToolIntegrity(server.name, serverTools, serverDefinition.integrity, options.integrityLabel)
        }
        for (const [toolName, tool] of Object.entries(serverTools || {})) {
          const definition = tool as AgentToolDefinition & { metadata?: Record<string, unknown> }
          const name = options.toolName(server.name, toolName)
          if (tools[name]) {
            throw new Error(`[vitehub] Duplicate MCP tool name "${name}" after normalization.`)
          }
          tools[name] = {
            ...definition,
            metadata: {
              ...definition.metadata,
              mcp: metadata,
              mcpServer: server.name,
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
      const errors: unknown[] = []
      for (const client of clients.splice(0).reverse()) {
        try {
          await client.close()
        }
        catch (error) {
          errors.push(error)
        }
      }
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1) throw new AggregateError(errors, "[vitehub] Multiple MCP clients failed to close.")
    },
  })
}
