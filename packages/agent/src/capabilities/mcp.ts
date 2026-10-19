import * as v from "valibot"

import { connectionMcpServerConfig, connectionMcpTransport, defineMcpToolCapability, mcpClientConfig, sanitizeMcpMetadata, withMcpInitializationCompatibility } from "../internal/mcp-tool-capability.ts"
import { agentConnectionsRuntime, connectionNameSchema, useAgentConnectionClient } from "./connection.ts"

import type {
  AgentCapabilityContext,
  AgentCapabilityDefinition,
  AgentRunInput,
  AgentRuntimeConfig,
} from "../types.ts"
import type { McpToolServerConnection } from "../internal/mcp-tool-capability.ts"
import type { McpAvailabilityWarning, McpCapabilityOptions, McpClient, McpClientConfig, McpConnectionServerConfig } from "../mcp/types.ts"
import type { WorkspaceName } from "@vite-hub/workspace"
import { agentDiagnostics } from "../agent-diagnostics.ts"

const mcpWarningSchema = v.object({
  phase: v.picklist(["discovery", "resolve"]),
  server: v.string(),
  statusCode: v.optional(v.pipe(v.number(), v.integer(), v.minValue(400), v.maxValue(599))),
})

/** Return valid MCP availability warnings recorded in an Agent run input. */
export function getMcpWarnings(input: AgentRunInput): McpAvailabilityWarning[] {
  const context = input.context
  if (!context || typeof context !== "object" || Array.isArray(context)) return []
  // SAFETY: The object guard above establishes a record-shaped Agent input context.
  const warnings = (context as Record<string, unknown>)["vitehub.mcp.warnings"]
  if (!Array.isArray(warnings)) return []
  return warnings.flatMap((warning) => {
    const parsed = v.safeParse(mcpWarningSchema, warning)
    return parsed.success ? [parsed.output] : []
  })
}

function normalizeMcpToolName(serverName: string, toolName: string) {
  return `mcp_${serverName}_${toolName}`.replace(/[^a-zA-Z0-9_]/g, "_")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isMcpClientConfig(value: McpClient | McpClientConfig | McpConnectionServerConfig): value is McpClientConfig | McpConnectionServerConfig {
  return ("transport" in value || "connection" in value)
    && !("tools" in value && typeof value.tools === "function"
      && "close" in value && typeof value.close === "function")
}

function namesConnection(value: McpClientConfig | McpConnectionServerConfig): value is McpConnectionServerConfig | (McpClientConfig & { connection: string }) {
  return value.connection !== undefined
}

/** A static server config that names a Connection. A resolver can also return `connection`; `useAgentConnectionClient()` checks the primitive when it runs. */
const connectionConfigSchema = v.looseObject({ connection: v.string(), transport: v.optional(v.looseObject({})) })

/**
 * Bind a server config to its Connection. An `optional` server is left out, without an
 * unavailable notice, until the Connection is connected. That case returns `null`.
 */
async function withMcpConnection(context: AgentCapabilityContext, server: string, config: McpClientConfig | McpConnectionServerConfig): Promise<{ binding: McpToolServerConnection, config: McpClientConfig } | null> {
  const name = v.safeParse(connectionNameSchema, config.connection)
  if (!name.success) {
    throw agentDiagnostics.AGENT_R0083({ message: `[vitehub] mcp({ servers }) server "${server}" requires a non-empty connection name.` })
  }
  connectionMcpTransport(server, config)
  const runtime = agentConnectionsRuntime(context, name.output, "mcp")
  if ("optional" in config && config.optional === true) {
    const inspection = await Promise.resolve().then(() => runtime.inspect?.(name.output)).catch(() => undefined)
    if (inspection?.status !== "connected") return null
  }
  const connection = useAgentConnectionClient(context, name.output, "mcp", { rejectApprovals: true })
  return {
    binding: { name: name.output },
    config: await connectionMcpServerConfig(server, config, {
      endpoint: async () => (await runtime.definition?.(name.output))?.provider.mcp,
      fetch: connection.fetch,
      name: name.output,
    }),
  }
}

function assertMcpIntegrityOptions(options: McpCapabilityOptions) {
  if (options.integrity === undefined) return
  if (!isRecord(options.integrity)) {
    throw agentDiagnostics.AGENT_R0114({ message: "[vitehub] mcp({ integrity }) requires fingerprint maps keyed by configured server name." })
  }
  for (const [server, fingerprints] of Object.entries(options.integrity)) {
    if (!Object.hasOwn(options.servers, server)) {
      throw agentDiagnostics.AGENT_R0115({ message: `[vitehub] mcp({ integrity }) references unknown server "${server}".` })
    }
    if (!isRecord(fingerprints) || Object.values(fingerprints).some(value => typeof value !== "string")) {
      throw agentDiagnostics.AGENT_R0116({ message: `[vitehub] mcp({ integrity }) requires a tool fingerprint map for server "${server}".` })
    }
  }
}

/** The options each mcp() Capability was created from, so a child Agent's mcp() can extend them. */
const mcpCapabilityOptions = new WeakMap<object, McpCapabilityOptions>()

/** Merge two maps keyed by server name. The child's entry for a server replaces the parent's. */
function mergeByServer<T>(parent: Record<string, T> | undefined, child: Record<string, T> | undefined): Record<string, T> | undefined {
  if (!parent || !child) return child ?? parent
  return { ...parent, ...child }
}

/** Keep only the entries of servers that remain configured. */
function pickServers<T>(map: Record<string, T> | undefined, servers: Record<string, unknown>): Record<string, T> | undefined {
  if (!map) return
  const picked = Object.fromEntries(Object.entries(map).filter(([name]) => Object.hasOwn(servers, name)))
  return Object.keys(picked).length ? picked : undefined
}

/**
 * Combine an inherited mcp() Capability with a child's. `servers`, `integrity`, and `toolOverrides`
 * merge by server name and the child wins; `false` removes an inherited server. Other options are
 * inherited unless the child sets them.
 */
function extendMcpOptions<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(parent: McpCapabilityOptions<TRuntimeConfig, Name>, child: McpCapabilityOptions<TRuntimeConfig, Name>): McpCapabilityOptions<TRuntimeConfig, Name> {
  const servers = Object.fromEntries(Object.entries({ ...parent.servers, ...child.servers }).filter(([, server]) => server !== false))
  const merged: McpCapabilityOptions<TRuntimeConfig, Name> = { ...parent, servers }
  for (const [key, value] of Object.entries(child)) {
    if (value !== undefined && key !== "servers") Object.assign(merged, { [key]: value })
  }
  const integrity = pickServers(mergeByServer(parent.integrity, child.integrity), servers)
  const toolOverrides = pickServers(mergeByServer(parent.toolOverrides, child.toolOverrides), servers)
  delete merged.integrity
  delete merged.toolOverrides
  return {
    ...merged,
    ...(integrity ? { integrity } : {}),
    ...(toolOverrides ? { toolOverrides } : {}),
  }
}

/**
 * Connect MCP servers and expose their tools to the Agent. In `defineAgent({ extends })`, a child's
 * `mcp()` extends the parent's `mcp()` Capability by server name unless it sets `inherit: false`.
 */
export function mcp<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
>(options: McpCapabilityOptions<TRuntimeConfig, Name>): AgentCapabilityDefinition<TRuntimeConfig, Name> {
  if (!options || typeof options !== "object" || !options.servers || typeof options.servers !== "object") {
    throw agentDiagnostics.AGENT_R0117({ message: "[vitehub] mcp({ servers }) requires a server map." })
  }
  const { inherit, ...layer } = options
  const capability = createMcpCapability(layer)
  // SAFETY: The map only returns options to mcp() Capabilities of the same Agent, which share these type parameters.
  mcpCapabilityOptions.set(capability, layer as McpCapabilityOptions)
  if (inherit === false) return capability
  return Object.assign(capability, {
    extend(inherited: AgentCapabilityDefinition<TRuntimeConfig, Name>) {
      // SAFETY: Options were stored for an mcp() Capability with the same type parameters.
      const parent = mcpCapabilityOptions.get(inherited) as McpCapabilityOptions<TRuntimeConfig, Name> | undefined
      return parent ? mcp(extendMcpOptions(parent, layer)) : capability
    },
  })
}

function createMcpCapability<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(options: McpCapabilityOptions<TRuntimeConfig, Name>): AgentCapabilityDefinition<TRuntimeConfig, Name> {
  assertMcpIntegrityOptions(options)
  const usesConnections = Object.values(options.servers).some(server => v.is(connectionConfigSchema, server))
  return defineMcpToolCapability({
    degradeUnavailable: true,
    id: "mcp",
    inspection: {
      label: "MCP",
      view: {
        root: "root",
        elements: {
          root: { type: "Stack", props: {}, children: ["empty", "servers"] },
          empty: { type: "Text", props: { text: { $state: "/empty" } } },
          servers: { type: "Stack", props: {}, repeat: { statePath: "/servers", key: "name" }, children: ["server"] },
          server: {
            type: "Section",
            props: { title: { $item: "/name" } },
            children: ["status", "connection", "tools"],
          },
          status: { type: "KeyValue", props: { label: "Discovery", value: { $item: "/status" } } },
          connection: { type: "KeyValue", props: { label: "Connection", value: { $item: "/connection" } } },
          tools: { type: "Tools", props: { mcpServer: { $item: "/name" } } },
        },
      },
    },
    integrityLabel: "mcp({ integrity })",
    invalidServerMessage: "[vitehub] mcp({ servers }) entries must resolve to an MCP client or MCP client config.",
    metadata: { servers: sanitizeMcpMetadata(options.servers) as Record<string, unknown> },
    ...(options.unavailableNotice !== undefined
      ? { unavailableNotice: options.unavailableNotice }
      : {}),
    ...(options.toolOverrides !== undefined
      ? { toolOverrides: options.toolOverrides }
      : {}),
    ...(usesConnections ? { requires: [{ primitive: "connections" }] } : {}),
    servers: Object.entries(options.servers).map(([name, server]) => ({
      name,
      async resolve(context) {
        const owned = typeof server === "function"
        const connection = owned ? await server(context) : server
        if (connection === false || connection === null || connection === undefined) return
        let resolved: McpClient | McpClientConfig
        let bound: Awaited<ReturnType<typeof withMcpConnection>> | undefined
        if (!isMcpClientConfig(connection)) resolved = connection
        else if (namesConnection(connection)) {
          bound = await withMcpConnection(context, name, connection)
          if (bound === null) return
          resolved = bound.config
        }
        else resolved = mcpClientConfig(connection)
        const tools = isMcpClientConfig(connection) && Array.isArray(connection.tools) ? connection.tools : undefined
        return {
          connection: withMcpInitializationCompatibility(resolved),
          ...(bound ? { connectionBinding: bound.binding } : {}),
          ...(tools ? { tools } : {}),
          integrity: options.integrity && Object.hasOwn(options.integrity, name)
            ? options.integrity[name]
            : undefined,
          owned,
        }
      },
    })),
    toolName: normalizeMcpToolName,
  })
}

export type {
  McpCapabilityOptions,
  McpClient,
  McpClientConfig,
  McpConnectionServerConfig,
  McpServerConfig,
  McpToolFingerprints,
  McpToolInputSchema,
} from "../mcp/types.ts"
