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

export function mcp<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
>(options: McpCapabilityOptions<TRuntimeConfig, Name>): AgentCapabilityDefinition<TRuntimeConfig, Name> {
  if (!options || typeof options !== "object" || !options.servers || typeof options.servers !== "object") {
    throw agentDiagnostics.AGENT_R0117({ message: "[vitehub] mcp({ servers }) requires a server map." })
  }
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
