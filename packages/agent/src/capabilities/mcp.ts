import * as v from "valibot"

import { defineMcpToolCapability, sanitizeMcpMetadata } from "../internal/mcp-tool-capability.ts"
import { connectionNameSchema, useAgentConnectionClient } from "./connection.ts"

import type {
  AgentCapabilityContext,
  AgentCapabilityDefinition,
  AgentRunInput,
  AgentRuntimeConfig,
} from "../types.ts"
import type { McpToolServerConnection } from "../internal/mcp-tool-capability.ts"
import type { McpAvailabilityWarning, McpCapabilityOptions, McpClient, McpClientConfig } from "../mcp/types.ts"
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
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Agent run context is an untrusted runtime boundary.
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

function isMcpClientConfig(value: McpClient | McpClientConfig): value is McpClientConfig {
  return "transport" in value
    && !("tools" in value && typeof value.tools === "function"
      && "close" in value && typeof value.close === "function")
}

function withMcpInitializationCompatibility(connection: McpClient | McpClientConfig): McpClient | McpClientConfig {
  if (!isMcpClientConfig(connection)) return connection
  return {
    ...connection,
    protocolVersionDiscovery: connection.protocolVersionDiscovery ?? false,
  }
}

type McpHttpTransportConfig = Extract<McpClientConfig["transport"], { url: string }>

function isHttpTransportConfig(transport: McpClientConfig["transport"]): transport is McpHttpTransportConfig {
  return isRecord(transport) && "type" in transport && (transport.type === "http" || transport.type === "sse") && "url" in transport
}

async function readMcpRequestBody(request: Request): Promise<string> {
  if (!request.signal) return request.text()
  if (request.signal.aborted) throw request.signal.reason ?? new DOMException("The operation was aborted.", "AbortError")
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(request.signal.reason ?? new DOMException("The operation was aborted.", "AbortError"))
    request.signal.addEventListener("abort", onAbort, { once: true })
    void request.text().then(
      body => {
        request.signal.removeEventListener("abort", onAbort)
        resolve(body)
      },
      error => {
        request.signal.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })
}

/** A static server config that names a Connection. A resolver can also return `connection`; `useAgentConnectionClient()` checks the primitive when it runs. */
const connectionConfigSchema = v.looseObject({ connection: v.string(), transport: v.looseObject({}) })

function withMcpConnection(context: AgentCapabilityContext, server: string, config: McpClientConfig): { binding: McpToolServerConnection, config: McpClientConfig } {
  const { connection: rawName, ...rest } = config
  const name = v.safeParse(connectionNameSchema, rawName)
  if (!name.success) {
    throw agentDiagnostics.AGENT_R0083({ message: `[vitehub] mcp({ servers }) server "${server}" requires a non-empty connection name.` })
  }
  const transport = rest.transport
  if (!isHttpTransportConfig(transport) || transport.authProvider) {
    throw agentDiagnostics.AGENT_R0082({ message: `[vitehub] mcp({ servers }) server "${server}" uses a connection, so it requires an http or sse transport config without authProvider.` })
  }
  const connection = useAgentConnectionClient(context, name.output, "mcp", { rejectApprovals: true })
  const fetch: typeof globalThis.fetch = async (input, init) => {
    // MCP needs each response in this session; durable approval replay cannot resume it.
    const target = new Request(input, init)
    const body = target.method === "GET" || target.method === "HEAD" ? undefined : await readMcpRequestBody(target)
    return connection.fetch(target.url, {
      body,
      headers: target.headers,
      method: target.method,
      redirect: target.redirect,
      signal: target.signal,
    })
  }
  return {
    binding: { name: name.output },
    config: { ...rest, transport: { ...transport, fetch } },
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
    // doctor-disable-next-line typescript/style/no-conditional-empty-object-spread -- Preserve the optional public property in the capability definition.
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
        const bound = isMcpClientConfig(connection) && connection.connection !== undefined
          ? withMcpConnection(context, name, connection)
          : undefined
        return {
          connection: withMcpInitializationCompatibility(bound?.config ?? connection),
          ...(bound ? { connectionBinding: bound.binding } : {}),
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
  McpToolInputSchema,
} from "../mcp/types.ts"
