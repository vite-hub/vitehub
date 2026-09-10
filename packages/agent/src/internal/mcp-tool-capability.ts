import { defineCapability } from "../capability-runtime.ts"
import { hasRuntimeType, isRuntimeObject, isRuntimeRecord } from "./runtime-type.ts"
import { ViteHubError } from "@vite-hub/runtime"
import { safeAgentTelemetryMetadata } from "./agent-telemetry.ts"
import { loadAiSdk } from "./ai-sdk-runtime.ts"

import type {
  AgentCapabilityDefinition,
  AgentCapabilityInspectionDefinition,
  AgentInspectionValue,
  AgentCapabilityRuntimeContext,
  AgentRuntimeConfig,
  AgentToolDefinition,
  AgentToolSet,
  MaybePromise,
} from "../types.ts"
import type { McpClient, McpClientConfig, McpToolFingerprints } from "../mcp/types.ts"
import type { WorkspaceName } from "@vite-hub/workspace"
import { agentDiagnostics } from "../agent-diagnostics.ts"

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
  inspection?: AgentCapabilityInspectionDefinition
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
  return isRuntimeRecord(value)
    && hasRuntimeType(value.tools, "function")
    && hasRuntimeType(value.close, "function")
}

function isMcpClientConfig(value: unknown): value is McpClientConfig {
  return isRuntimeObject(value)
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
  if (hasRuntimeType(value, "function")) return "[function]"
  if (hasRuntimeType(value, "string")) return sanitizeMetadataUrl(value)
  if (!isRuntimeObject(value)) return value
  if (value instanceof URL) return sanitizeMetadataUrl(value)
  if (seen.has(value)) return "[circular]"
  seen.add(value)
  if (Array.isArray(value)) return value.map(item => sanitizeMcpMetadata(item, seen))
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    output[key] = secretKeyPattern.test(key) ? "[redacted]" : sanitizeMcpMetadata(item, seen)
  }
  return output
}

async function assertMcpToolIntegrity(server: string, tools: Record<string, unknown>, baseline: McpToolFingerprints, integrityLabel: string): Promise<void> {
  const aiSdk = await loadAiSdk()
  if (!hasRuntimeType(aiSdk.fingerprintTools, "function") || !hasRuntimeType(aiSdk.detectToolDrift, "function")) {
    throw agentDiagnostics.AGENT_R0561({ message: `[vitehub] ${integrityLabel} requires ai 7.0.19 or newer.` })
  }
  // SAFETY: MCP client tool discovery returns AI SDK tool definitions, while the public adapter keeps their generic shape opaque.
  const current = await aiSdk.fingerprintTools(tools as never)
  const drift = aiSdk.detectToolDrift(current, baseline)
  if (drift.added.length || drift.changed.length) {
    throw mcpToolDefinitionDriftError(server, drift, integrityLabel)
  }
}

async function resolveMcpToolServer(
  resolved: ResolvedMcpToolServer,
  invalidServerMessage: string,
  createMcpClient?: (config: McpClientConfig) => Promise<McpClient>,
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
    if (!createMcpClient) throw agentDiagnostics.AGENT_R0562({ message: invalidServerMessage })
    return {
      client: await createMcpClient(resolved.connection),
      metadata: sanitizeMcpMetadata(resolved.connection),
      owned: true,
    }
  }
  throw agentDiagnostics.AGENT_R0562({ message: invalidServerMessage })
}

export function defineMcpToolCapability<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
>(options: McpToolCapabilityOptions<TRuntimeConfig, Name>): AgentCapabilityDefinition<TRuntimeConfig, Name> {
  const clientsByContext = new WeakMap<AgentCapabilityRuntimeContext<TRuntimeConfig, Name>, Array<McpClient | undefined>>()
  return defineCapability({
    id: options.id,
    ...(options.inspection ? { inspection: options.inspection } : {}),
    metadata: options.metadata,
    async resolve(context) {
      const tools: AgentToolSet = {}
      const clients: McpClient[] = []
      const servers: Array<Record<string, AgentInspectionValue>> = options.servers.map(server => ({ name: server.name, status: "Not resolved", tools: [] }))
      const publishInspection = async () => {
        if (options.inspection) await context.inspection.set({ servers, empty: servers.length ? "" : "No MCP servers configured." })
      }
      clientsByContext.set(context, clients)
      await publishInspection()
      const definitions = await Promise.allSettled(options.servers.map(async server => await server.resolve(context)))
      for (const [index, definition] of definitions.entries()) {
        servers[index]!.status = definition.status === "rejected" ? "Resolution failed" : definition.value ? "Not discovered" : "Skipped"
        if (definition.status !== "fulfilled" || !definition.value) continue
        if (isMcpClient(definition.value.connection) && definition.value.owned !== false) {
          clients[index] = definition.value.connection
        }
      }
      const definitionFailure = definitions.find(result => result.status === "rejected")
      await publishInspection()
      if (definitionFailure?.status === "rejected") throw definitionFailure.reason
      const needsMcpRuntime = definitions.some(result => result.status === "fulfilled"
        && result.value
        && !isMcpClient(result.value.connection)
        && isMcpClientConfig(result.value.connection))
      const mcpRuntime = needsMcpRuntime ? await import("@ai-sdk/mcp") : undefined
      const results = await Promise.allSettled(options.servers.map(async (server, index) => {
        const definition = definitions[index]
        if (definition?.status !== "fulfilled") return
        const serverDefinition = definition.value
        if (serverDefinition === false || serverDefinition === null || serverDefinition === undefined) return
        const { client, metadata, owned } = await resolveMcpToolServer(
          serverDefinition,
          options.invalidServerMessage,
          mcpRuntime ? config => mcpRuntime.createMCPClient(config) : undefined,
        )
        if (owned) clients[index] = client
        const serverTools = await client.tools()
        if (serverDefinition.integrity) {
          await assertMcpToolIntegrity(server.name, serverTools, serverDefinition.integrity, options.integrityLabel)
        }
        servers[index]!.connection = safeAgentTelemetryMetadata(metadata) ?? {}
        servers[index]!.tools = Object.keys(serverTools || {}).map(name => options.toolName(server.name, name))
        return { metadata, server, serverTools }
      }))
      for (const [index, result] of results.entries()) {
        if (result.status === "rejected") servers[index]!.status = "Discovery failed"
        else if (result.value) servers[index]!.status = "Resolved"
      }
      await publishInspection()
      const failure = results.find(result => result.status === "rejected")
      if (failure?.status === "rejected") throw failure.reason
      for (const result of results) {
        if (result.status !== "fulfilled" || !result.value) continue
        const { metadata, server, serverTools } = result.value
        for (const [toolName, tool] of Object.entries(serverTools || {})) {
          // SAFETY: McpClient.tools() establishes that each discovered entry is an Agent tool definition.
          const definition = tool as AgentToolDefinition & { metadata?: Record<string, unknown> }
          const name = options.toolName(server.name, toolName)
          if (tools[name]) {
            throw agentDiagnostics.AGENT_R0563({ message: `[vitehub] Duplicate MCP tool name "${name}" after normalization.` })
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
      const closes = await Promise.allSettled(clients.splice(0).reverse().map(async client => {
        await client?.close()
      }))
      for (const result of closes) if (result.status === "rejected") errors.push(result.reason)
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1) throw new AggregateError(errors, "[vitehub] Multiple MCP clients failed to close.")
    },
  })
}
