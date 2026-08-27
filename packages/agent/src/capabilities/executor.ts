import { defineMcpToolCapability, sanitizeMcpMetadata } from "../internal/mcp-tool-capability.ts"

import type {
  AgentCapabilityDefinition,
  AgentCapabilityRuntimeContext,
  AgentRuntimeConfig,
  MaybePromise,
} from "../types.ts"
import type { McpToolFingerprints } from "../mcp/types.ts"
import type { WorkspaceName } from "@vite-hub/workspace"

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function executorUrl(value: unknown): URL {
  if (typeof value !== "string" && !(value instanceof URL)) {
    throw new TypeError("[vitehub] executor({ url }) requires an HTTP MCP endpoint URL.")
  }
  let url: URL
  try {
    url = new URL(value)
  }
  catch {
    throw new TypeError("[vitehub] executor({ url }) requires a valid HTTP MCP endpoint URL.")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("[vitehub] executor({ url }) supports only HTTP and HTTPS MCP endpoint URLs.")
  }
  if (url.username || url.password) {
    throw new TypeError("[vitehub] executor({ url }) does not accept credentials embedded in the MCP endpoint URL. Use apiKey instead.")
  }
  return url
}

function assertExecutorIntegrity(value: unknown): asserts value is McpToolFingerprints | undefined {
  if (value === undefined) return
  if (!isRecord(value) || Object.values(value).some(fingerprint => typeof fingerprint !== "string")) {
    throw new TypeError("[vitehub] executor({ integrity }) requires a tool fingerprint map.")
  }
}

function assertExecutorCredential(value: unknown): asserts value is ExecutorCredential {
  if (typeof value === "string") {
    if (value.trim()) return
    throw new TypeError("[vitehub] executor({ apiKey }) must not be empty when provided.")
  }
  if (isRecord(value) && typeof value.unseal === "function") return
  throw new TypeError("[vitehub] executor({ apiKey }) requires a string or sealed Server Env value when provided.")
}

function assertExecutorConnectionOptions(value: unknown): asserts value is ExecutorConnectionOptions {
  if (!isRecord(value)) {
    throw new TypeError("[vitehub] executor() requires connection options or a connection resolver.")
  }
  const url = executorUrl(value.url)
  assertExecutorIntegrity(value.integrity)
  if (value.timeout !== undefined && (typeof value.timeout !== "number" || !Number.isFinite(value.timeout) || value.timeout <= 0)) {
    throw new TypeError("[vitehub] executor({ timeout }) requires a positive number of milliseconds.")
  }
  if (Object.hasOwn(value, "apiKey")) {
    assertExecutorCredential(value.apiKey)
    if (url.protocol !== "https:") {
      throw new TypeError("[vitehub] executor({ apiKey }) requires an HTTPS MCP endpoint URL.")
    }
  }
}

function resolveExecutorCredential(value: ExecutorCredential): string {
  const credential = typeof value === "string" ? value : value.unseal()
  if (typeof credential !== "string" || !credential.trim()) {
    throw new TypeError("[vitehub] executor({ apiKey }) must resolve to a non-empty string.")
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
  if (typeof options !== "function" && options !== false && options !== null && options !== undefined) {
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
        const resolved = typeof options === "function" ? await options(context) : options
        if (resolved === false || resolved === null || resolved === undefined) return
        assertExecutorConnectionOptions(resolved)
        const url = executorUrl(resolved.url)
        const transport: Record<string, unknown> = {
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
