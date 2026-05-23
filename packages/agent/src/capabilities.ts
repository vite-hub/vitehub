import {
  executeHttpRequest,
  parseStandardSchema,
} from "@vitehub/internal/http-request"
import {
  defineCapability,
  normalizeMode,
} from "./capability-runtime.ts"

import type {
  AgentCapabilityContext,
  AgentCapabilityDefinition,
  AgentCapabilityMode,
  AgentToolDefinition,
  AgentToolSet,
  MaybePromise,
} from "./types.ts"

export type FetchCapabilityMethod = "GET" | "HEAD" | "POST"
export type FetchCapabilityResponseType = "json" | "text"

export interface FetchCapabilityStandardSchemaResultSuccess<T = unknown> {
  issues?: undefined
  value: T
}

export interface FetchCapabilityStandardSchemaResultFailure {
  issues: readonly unknown[]
}

export interface FetchCapabilityStandardSchemaV1<T = unknown> {
  "~standard": {
    validate: (input: unknown) => FetchCapabilityStandardSchemaResultSuccess<T> | FetchCapabilityStandardSchemaResultFailure | Promise<FetchCapabilityStandardSchemaResultSuccess<T> | FetchCapabilityStandardSchemaResultFailure>
  }
}

export interface FetchCapabilityRequestOptions {
  body?: unknown
  headers?: Record<string, string>
  method?: FetchCapabilityMethod
  query?: Record<string, unknown>
  timeout?: number
}

export interface FetchCapabilityRequestDefinition extends FetchCapabilityRequestOptions {
  url: string | URL
}

export interface FetchCapabilityToolOptions<TInput = unknown, TResponse = unknown, TOutput = TResponse> {
  description?: string
  inputSchema?: FetchCapabilityStandardSchemaV1<TInput>
  method?: FetchCapabilityMethod
  request?: FetchCapabilityToolRequest<TInput>
  responseType?: FetchCapabilityResponseType
  schema?: FetchCapabilityStandardSchemaV1<TResponse>
  transform?: (data: TResponse, input: TInput) => TOutput | Promise<TOutput>
  url?: string | URL
}

export type FetchCapabilityToolRequest<TInput = unknown> =
  | (FetchCapabilityRequestOptions & { url?: string | URL })
  | ((input: TInput) => MaybePromise<FetchCapabilityRequestDefinition | (FetchCapabilityRequestOptions & { url?: string | URL })>)

export interface FetchCapabilityOptions<TTools extends Record<string, FetchCapabilityToolOptions<any, any, any>> = Record<string, FetchCapabilityToolOptions>> {
  tools: TTools
}

function primitiveHandle(context: AgentCapabilityContext, name: string): unknown {
  const handle = context.capabilities?.[name] as { value?: unknown } | unknown
  return typeof handle === "object" && handle !== null && "value" in handle
    ? (handle as { value?: unknown }).value
    : handle
}

function requirePrimitive(context: AgentCapabilityContext, name: string): unknown {
  const handle = primitiveHandle(context, name)
  if (!handle) throw new Error(`[vitehub] Capability "${name}" requires the ${name} primitive to be configured.`)
  return handle
}

function defineInternalTool<TInput = unknown, TOutput = unknown>(
  tool: AgentToolDefinition<TInput, TOutput>,
): AgentToolDefinition<TInput, TOutput> {
  if (!tool || typeof tool !== "object") {
    throw new TypeError("[vitehub] tool definitions must be objects.")
  }
  if (!tool.name || typeof tool.name !== "string") {
    throw new TypeError("[vitehub] tool definitions require a tool name.")
  }
  return tool
}

function normalizeFetchResponseType(responseType: string | undefined): FetchCapabilityResponseType {
  const normalized = responseType || "json"
  if (normalized !== "json" && normalized !== "text") {
    throw new TypeError(`[vitehub] fetch() responseType "${normalized}" is not supported in v1. Use json or text.`)
  }
  return normalized
}

function validateSandboxCommands(commands: unknown): string[] {
  if (!Array.isArray(commands) || !commands.length) {
    throw new TypeError("[vitehub] sandbox({ commands }) requires at least one executable name.")
  }
  for (const command of commands) {
    if (typeof command !== "string" || !/^[A-Za-z0-9_.-]+$/.test(command)) {
      throw new TypeError("[vitehub] sandbox({ commands }) accepts executable names only, not shell command strings.")
    }
  }
  return commands
}

export function bash(options: { mode?: AgentCapabilityMode } = {}): AgentCapabilityDefinition {
  const mode = normalizeMode(options.mode, "Bash")
  return defineCapability({
    id: "bash",
    mode,
    requires: [{ primitive: "workspace", workspace: { mode, required: true } }],
    tools: ({ workspace }) => (mode === "write" && "write" in workspace.tools
      ? (workspace.tools as unknown as { write: () => AgentToolSet }).write()
      : workspace.tools.inspect()) as AgentToolSet,
  })
}

export function sandbox(options: { commands: string[] }): AgentCapabilityDefinition {
  const commands = validateSandboxCommands(options?.commands)
  return defineCapability({
    id: "sandbox",
    metadata: { commands },
    requires: [{ primitive: "workspace", workspace: { required: true } }, { primitive: "sandbox" }],
    tools: (context) => {
      const handle = requirePrimitive(context as never, "sandbox") as {
        exec?: (command: string, args?: string[], options?: unknown) => MaybePromise<unknown>
      }
      return {
        sandbox_exec: defineInternalTool({
          description: `Run one allowed executable in an isolated sandbox. Allowed commands: ${commands.join(", ")}.`,
          name: "sandbox_exec",
          async execute(input) {
            const value = input as { args?: string[], command?: string, cwd?: string, env?: Record<string, string>, timeout?: number }
            if (!value || typeof value.command !== "string") throw new TypeError("[vitehub] sandbox_exec requires a command.")
            if (!commands.includes(value.command)) throw new Error(`[vitehub] Sandbox command "${value.command}" is not allowed.`)
            if (!handle.exec) throw new Error("[vitehub] Sandbox primitive does not expose exec().")
            return await handle.exec(value.command, value.args || [], { cwd: value.cwd, env: value.env, timeout: value.timeout })
          },
        }),
      }
    },
  })
}

export function skills(options: { path?: string } = {}): AgentCapabilityDefinition {
  const path = options.path || "skills"
  const skillPath = path.replace(/\/+$/, "").endsWith("/SKILL.md")
    ? path.replace(/\/+$/, "")
    : `${path.replace(/\/+$/, "")}/SKILL.md`
  return defineCapability({
    id: "skills",
    metadata: { path: path.replace(/\/+$/, ""), skillPath },
    requires: [{ primitive: "workspace", workspace: { mode: "read", paths: [skillPath], required: true } }],
  })
}

export function fetch<const TTools extends Record<string, FetchCapabilityToolOptions<any, any, any>>>(options: FetchCapabilityOptions<TTools>): AgentCapabilityDefinition {
  if (!options?.tools || typeof options.tools !== "object" || !Object.keys(options.tools).length) {
    throw new TypeError("[vitehub] fetch({ tools }) requires at least one fetch tool.")
  }
  return defineCapability({
    id: "fetch",
    tools: Object.fromEntries(Object.entries(options.tools).map(([name, toolOptions]) => [
      name,
      createFetchTool(name, toolOptions),
    ])),
  })
}

function createFetchTool(name: string, options: FetchCapabilityToolOptions): AgentToolDefinition {
  return defineInternalTool({
    description: options.description || `Fetch ${name}.`,
    inputSchema: options.inputSchema,
    name,
    async execute(input) {
      const parsedInput = options.inputSchema
        ? await parseStandardSchema(options.inputSchema, input, `${name} input`)
        : input
      const request = await resolveFetchToolRequest(options, parsedInput)
      const result = await executeHttpRequest(request, {
        responseType: normalizeFetchResponseType(options.responseType),
        schema: options.schema,
      })
      return options.transform
        ? await options.transform(result.data as never, parsedInput as never)
        : result.data
    },
  })
}

async function resolveFetchToolRequest(options: FetchCapabilityToolOptions, input: unknown): Promise<FetchCapabilityRequestDefinition> {
  const request = typeof options.request === "function"
    ? await options.request(input as never)
    : options.request
  const url = request?.url ?? options.url
  if (!url) throw new TypeError("[vitehub] fetch() tool requires a url or request returning a url.")
  return {
    ...request,
    method: request?.method ?? options.method,
    url,
  }
}

export function mcp(options: { servers?: Record<string, unknown> } = {}): AgentCapabilityDefinition {
  return defineCapability({
    id: "mcp",
    metadata: { servers: options.servers || {} },
  })
}

export {
  blob,
  db,
  kv,
} from "./capabilities/storage/index.ts"
export {
  memory,
  workspaceJsonlMemoryStore,
} from "./memory.ts"
export {
  normalizeAgentUsage,
  staticModelPricing,
  usageTelemetry,
  vercelAiGatewayPricing,
} from "./capabilities/usage-telemetry.ts"

export type {
  BlobCapabilityOptions,
  DBCapabilityOptions,
  KVCapabilityOptions,
  StorageToolPolicy,
} from "./capabilities/storage/index.ts"
export type {
  MemoryAppendRequest,
  MemoryCapabilityInstructionsOption,
  MemoryCapabilityOptions,
  MemoryDeleteRequest,
  MemoryExportRequest,
  MemoryKind,
  MemoryProvenance,
  MemoryReadRequest,
  MemoryRecord,
  MemoryScope,
  MemorySearchRequest,
  MemorySearchResult,
  MemoryStoreAdapter,
  MemoryStoreFactory,
  MemoryStoreOptions,
  WorkspaceJsonlMemoryStoreOptions,
} from "./memory.ts"
export type {
  AgentUsagePricing,
  AgentUsagePricingContext,
  StaticModelPrice,
  UsageTelemetryOptions,
  VercelAiGatewayPricingOptions,
} from "./capabilities/usage-telemetry.ts"
