import * as v from "valibot"
import { defineMcpToolCapability, mcpWarningsContextKey, sanitizeMcpMetadata, withMcpInitializationCompatibility } from "../internal/mcp-tool-capability.ts"
import { isCallableMember } from "../internal/runtime-type.ts"

import type {
  AgentCapabilityDefinition,
  AgentRuntimeConfig,
} from "../types.ts"
import type { McpAvailabilityWarning, McpCapabilityOptions } from "../mcp/types.ts"
import type { WorkspaceName } from "@vite-hub/workspace"
import { agentDiagnostics } from "../agent-diagnostics.ts"

function normalizeMcpToolName(serverName: string, toolName: string) {
  return `mcp_${serverName}_${toolName}`.replace(/[^a-zA-Z0-9_]/g, "_")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
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

function defaultMcpUnavailableNotice(servers: string[]): string {
  return `> ⚠️ ${servers.join(", ")} tools were temporarily unavailable. I answered with the remaining context.`
}

const mcpAvailabilityWarningSchema = v.object({
  server: v.string(),
  phase: v.picklist(["resolve", "discovery"]),
  statusCode: v.optional(v.pipe(v.number(), v.finite())),
})

/** Read the MCP servers that were unavailable during one Invocation, for example `getMcpWarnings(event.input)`. */
export function getMcpWarnings(input: { context?: unknown } | undefined): McpAvailabilityWarning[] {
  const context = input?.context
  const warnings = isRecord(context) ? context[mcpWarningsContextKey] : undefined
  return Array.isArray(warnings)
    ? warnings.filter((warning): warning is McpAvailabilityWarning => v.is(mcpAvailabilityWarningSchema, warning))
    : []
}

export function mcp<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
>(options: McpCapabilityOptions<TRuntimeConfig, Name>): AgentCapabilityDefinition<TRuntimeConfig, Name> {
  if (!options || typeof options !== "object" || !options.servers || typeof options.servers !== "object") {
    throw agentDiagnostics.AGENT_R0117({ message: "[vitehub] mcp({ servers }) requires a server map." })
  }
  assertMcpIntegrityOptions(options)
  const unavailableNotice = options.unavailableNotice === true
    ? defaultMcpUnavailableNotice
    : isCallableMember(options.unavailableNotice) ? options.unavailableNotice : undefined
  return defineMcpToolCapability({
    degradeUnavailable: true,
    unavailableNotice,
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
  McpAvailabilityWarning,
  McpCapabilityOptions,
  McpClient,
  McpClientConfig,
  McpServerConfig,
  McpToolFingerprints,
} from "../mcp/types.ts"
