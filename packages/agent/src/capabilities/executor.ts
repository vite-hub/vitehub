import { defineMcpToolCapability, sanitizeMcpMetadata } from "../internal/mcp-tool-capability.ts"
import { hasRuntimeType, isRuntimeRecord } from "../internal/runtime-type.ts"

import type {
  AgentCapabilityDefinition,
  AgentCapabilityRuntimeContext,
  AgentRuntimeConfig,
  MaybePromise,
} from "../types.ts"
import type { McpClientConfig, McpToolFingerprints } from "../mcp/types.ts"
import type { WorkspaceName } from "@vite-hub/workspace"
import { agentDiagnostics } from "../agent-diagnostics.ts"

export type ExecutorCredential = string | { unseal: () => string }

export interface ExecutorConnectionOptions {
  apiKey?: ExecutorCredential
  integrity?: McpToolFingerprints
  timeout?: number
  url: string | URL
}

export type ExecutorCapabilityOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> =
  | ExecutorConnectionOptions
  | false
  | null
  | undefined
  | ((context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) => MaybePromise<ExecutorConnectionOptions | false | null | undefined>)

const defaultExecutorConnectionTimeout = 30_000

function executorUrl(value: unknown): URL {
  if (!hasRuntimeType(value, "string") && !(value instanceof URL)) {
    throw agentDiagnostics.AGENT_R0038({ message: "[vitehub] executor({ url }) requires an HTTP MCP endpoint URL." })
  }
  let url: URL
  try {
    url = new URL(value)
  }
  catch {
    throw agentDiagnostics.AGENT_R0039({ message: "[vitehub] executor({ url }) requires a valid HTTP MCP endpoint URL." })
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw agentDiagnostics.AGENT_R0040({ message: "[vitehub] executor({ url }) supports only HTTP and HTTPS MCP endpoint URLs." })
  }
  if (url.username || url.password) {
    throw agentDiagnostics.AGENT_R0041({ message: "[vitehub] executor({ url }) does not accept credentials embedded in the MCP endpoint URL. Use apiKey instead." })
  }
  return url
}

function assertExecutorIntegrity(value: unknown): asserts value is McpToolFingerprints | undefined {
  if (value === undefined) return
  if (!isRuntimeRecord(value) || Object.values(value).some(fingerprint => !hasRuntimeType(fingerprint, "string"))) {
    throw agentDiagnostics.AGENT_R0042({ message: "[vitehub] executor({ integrity }) requires a tool fingerprint map." })
  }
}

function assertExecutorCredential(value: unknown): asserts value is ExecutorCredential {
  if (hasRuntimeType(value, "string")) {
    if (value.trim()) return
    throw agentDiagnostics.AGENT_R0043({ message: "[vitehub] executor({ apiKey }) must not be empty when provided." })
  }
  if (isRuntimeRecord(value) && hasRuntimeType(value.unseal, "function")) return
  throw agentDiagnostics.AGENT_R0044({ message: "[vitehub] executor({ apiKey }) requires a string or sealed Server Env value when provided." })
}

function assertExecutorConnectionOptions(value: unknown): asserts value is ExecutorConnectionOptions {
  if (!isRuntimeRecord(value)) {
    throw agentDiagnostics.AGENT_R0045({ message: "[vitehub] executor() requires connection options or a connection resolver." })
  }
  const url = executorUrl(value.url)
  assertExecutorIntegrity(value.integrity)
  if (value.timeout !== undefined && (!hasRuntimeType(value.timeout, "number") || !Number.isFinite(value.timeout) || value.timeout <= 0)) {
    throw agentDiagnostics.AGENT_R0046({ message: "[vitehub] executor({ timeout }) requires a positive number of milliseconds." })
  }
  if (Object.hasOwn(value, "apiKey")) {
    assertExecutorCredential(value.apiKey)
    if (url.protocol !== "https:") {
      throw agentDiagnostics.AGENT_R0047({ message: "[vitehub] executor({ apiKey }) requires an HTTPS MCP endpoint URL." })
    }
  }
}

function resolveExecutorCredential(value: ExecutorCredential): string {
  const credential = hasRuntimeType(value, "string") ? value : value.unseal()
  if (!hasRuntimeType(credential, "string") || !credential.trim()) {
    throw agentDiagnostics.AGENT_R0048({ message: "[vitehub] executor({ apiKey }) must resolve to a non-empty string." })
  }
  return credential
}

function executorToolName(_serverName: string, toolName: string): string {
  const normalized = toolName.replace(/[^a-zA-Z0-9_]/g, "_")
  return normalized === "execute" ? "executor" : `executor_${normalized}`
}

export function executor<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
>(options: ExecutorCapabilityOptions<TRuntimeConfig, Name>): AgentCapabilityDefinition<TRuntimeConfig, Name> {
  if (!hasRuntimeType(options, "function") && options !== false && options !== null && options !== undefined) {
    assertExecutorConnectionOptions(options)
  }

  return defineMcpToolCapability({
    id: "executor",
    integrityLabel: "executor({ integrity })",
    invalidServerMessage: "[vitehub] executor() must resolve to Executor connection options.",
    metadata: {
      connection: sanitizeMcpMetadata(options),
    },
    servers: [{
      name: "executor",
      async resolve(context) {
        const resolved = hasRuntimeType(options, "function") ? await options(context) : options
        if (resolved === false || resolved === null || resolved === undefined) return
        assertExecutorConnectionOptions(resolved)
        const url = executorUrl(resolved.url)
        const transport: McpClientConfig["transport"] = {
          type: "http",
          url: url.href,
        }
        if (Object.hasOwn(resolved, "apiKey")) {
          const apiKey = resolved.apiKey
          assertExecutorCredential(apiKey)
          transport.headers = {
            Authorization: `Bearer ${resolveExecutorCredential(apiKey)}`,
          }
        }
        return {
          connection: {
            initializationOptions: {
              signal: context.abortSignal,
              timeout: resolved.timeout ?? defaultExecutorConnectionTimeout,
            },
            transport,
          },
          integrity: resolved.integrity,
        }
      },
    }],
    toolName: executorToolName,
  })
}
