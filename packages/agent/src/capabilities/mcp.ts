import { defineMcpToolCapability, sanitizeMcpMetadata } from "../internal/mcp-tool-capability.ts"

import type {
  AgentCapabilityDefinition,
  AgentRuntimeConfig,
} from "../types.ts"
import type { McpCapabilityOptions, McpClient, McpClientConfig } from "../mcp/types.ts"
import type { WorkspaceName } from "@vite-hub/workspace"

function normalizeMcpToolName(serverName: string, toolName: string) {
  return `mcp_${serverName}_${toolName}`.replace(/[^a-zA-Z0-9_]/g, "_")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isMcpClientConfig(value: McpClient | McpClientConfig): value is McpClientConfig {
  return "transport" in value
    && !("tools" in value && typeof value.tools === "function"
      && "close" in value && typeof value.close === "function")
}

function withMcpInitializationCompatibility(connection: McpClient | McpClientConfig): McpClient | McpClientConfig {
  if (!isMcpClientConfig(connection)) return connection
  return {
    ...connection,
    initializationOptions: {
      protocolVersionDiscovery: false,
      ...connection.initializationOptions,
    },
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

export function mcp<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
>(options: McpCapabilityOptions<TRuntimeConfig, Name>): AgentCapabilityDefinition<TRuntimeConfig, Name> {
  if (!options || typeof options !== "object" || !options.servers || typeof options.servers !== "object") {
    throw new TypeError("[vitehub] mcp({ servers }) requires a server map.")
  }
  assertMcpIntegrityOptions(options)
  return defineMcpToolCapability({
    id: "mcp",
    integrityLabel: "mcp({ integrity })",
    invalidServerMessage: "[vitehub] mcp({ servers }) entries must resolve to an MCP client or MCP client config.",
    metadata: { servers: sanitizeMcpMetadata(options.servers) as Record<string, unknown> },
    servers: Object.entries(options.servers).map(([name, server]) => ({
      name,
      async resolve(context) {
        const owned = typeof server === "function"
        const connection = owned ? await server(context) : server
        if (connection === false || connection === null || connection === undefined) return
        return {
          connection: withMcpInitializationCompatibility(connection),
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
  McpServerConfig,
  McpToolFingerprints,
} from "../mcp/types.ts"
