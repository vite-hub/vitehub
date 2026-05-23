import {
  defineCapability,
  normalizeMode,
} from "./capability-runtime.ts"

import type {
  AgentCapabilityContext,
  AgentCapabilityDefinition,
  AgentCapabilityMode,
  AgentToolDefinition,
  AgentToolPolicyDecision,
  AgentToolPolicyContext,
  AgentToolSet,
  MaybePromise,
} from "./types.ts"

type JsonSchema = Record<string, unknown>
export type StorageToolPolicy = AgentToolPolicyDecision | ((context: AgentToolPolicyContext) => MaybePromise<AgentToolPolicyDecision>)

interface PrimitiveStorageCapabilityOptions {
  mode?: AgentCapabilityMode
  policy?: StorageToolPolicy
  store?: string
}

export interface KVCapabilityOptions extends PrimitiveStorageCapabilityOptions {}

export interface BlobCapabilityOptions extends PrimitiveStorageCapabilityOptions {}

export interface DBCapabilityOptions {
  database?: string
  mode?: AgentCapabilityMode
  policy?: StorageToolPolicy
  schemaMode?: AgentCapabilityMode
}

interface KVReadInput {
  key?: string
  prefix?: string
}

interface KVEditInput {
  key: string
  operation: "delete" | "put"
  value?: unknown
}

interface BlobReadInput {
  cursor?: string
  folded?: boolean
  limit?: number
  operation: "get" | "head" | "list"
  pathname?: string
  prefix?: string
}

interface BlobEditInput {
  body?: unknown
  operation: "delete" | "put"
  options?: Record<string, unknown>
  pathname: string
}

interface DbSqlInput {
  statement: string
}

interface DbExecInput extends DbSqlInput {
  rationale: string
}

const defaultListLimit = 25
const maxListLimit = 100

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

function createTool<TInput = unknown, TOutput = unknown>(tool: AgentToolDefinition<TInput, TOutput>): AgentToolDefinition {
  return defineInternalTool(tool) as AgentToolDefinition
}

function jsonObjectSchema(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return {
    additionalProperties: false,
    properties,
    ...(required.length ? { required } : {}),
    type: "object",
  }
}

const kvReadInputSchema = jsonObjectSchema({
  key: { description: "Read one KV value by exact key.", type: "string" },
  prefix: { description: "List KV keys under this developer-provided prefix.", type: "string" },
})

const kvEditInputSchema = jsonObjectSchema({
  key: { type: "string" },
  operation: { enum: ["delete", "put"], type: "string" },
  value: {},
}, ["key", "operation"])

const blobReadInputSchema = jsonObjectSchema({
  cursor: { type: "string" },
  folded: { type: "boolean" },
  limit: { maximum: maxListLimit, minimum: 1, type: "number" },
  operation: { enum: ["get", "head", "list"], type: "string" },
  pathname: { type: "string" },
  prefix: { description: "List Blob objects under this developer-provided prefix.", type: "string" },
}, ["operation"])

const blobEditInputSchema = jsonObjectSchema({
  body: {},
  operation: { enum: ["delete", "put"], type: "string" },
  options: { additionalProperties: true, type: "object" },
  pathname: { type: "string" },
}, ["operation", "pathname"])

const dbQueryInputSchema = jsonObjectSchema({
  statement: { type: "string" },
}, ["statement"])

const dbExecInputSchema = jsonObjectSchema({
  rationale: { type: "string" },
  statement: { type: "string" },
}, ["statement", "rationale"])

function hasExactlyOne(...values: unknown[]) {
  return values.filter(value => typeof value === "string" && value.trim()).length === 1
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`[vitehub] ${label} must be a non-empty string.`)
  }
  return value
}

function method<T extends (...args: never[]) => unknown>(handle: unknown, primitive: string, name: string): T {
  const fn = typeof handle === "object" && handle !== null ? (handle as Record<string, unknown>)[name] : undefined
  if (typeof fn !== "function") throw new Error(`[vitehub] ${primitive} primitive does not expose ${name}().`)
  return fn.bind(handle) as T
}

function selectStore(handle: unknown, primitive: "Blob" | "KV", store?: string): unknown {
  if (!store) return handle
  const storeFn = typeof handle === "object" && handle !== null ? (handle as { store?: unknown }).store : undefined
  if (typeof storeFn !== "function") throw new Error(`[vitehub] ${primitive} Capability store selection requires the ${primitive.toLowerCase()} primitive to expose store().`)
  return storeFn.call(handle, store)
}

function selectDatabase(handle: unknown, database = "default"): unknown {
  if (typeof handle !== "object" || handle === null) return handle
  if ("databases" in handle) {
    const databaseHandle = (handle as { databases?: Record<string, unknown> }).databases?.[database]
    if (!databaseHandle) throw new Error(`[vitehub] Database "${database}" is not available.`)
    return databaseHandle
  }
  if (database !== "default") {
    const databaseFn = (handle as { database?: unknown }).database
    if (typeof databaseFn === "function") return databaseFn.call(handle, database)
    throw new Error(`[vitehub] Database "${database}" is not available.`)
  }
  return handle
}

function normalizeListLimit(limit: unknown): number {
  if (limit === undefined) return defaultListLimit
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1) {
    throw new TypeError("[vitehub] list limit must be a positive number.")
  }
  return Math.min(Math.floor(limit), maxListLimit)
}

function hasOnlyTrailingComments(value: string) {
  let index = 0
  while (index < value.length) {
    const char = value[index]
    const next = value[index + 1]

    if (/\s/.test(char || "")) {
      index++
      continue
    }
    if (char === "-" && next === "-") {
      index += 2
      while (index < value.length && value[index] !== "\n" && value[index] !== "\r") index++
      continue
    }
    if (char === "/" && next === "*") {
      index += 2
      while (index < value.length && !(value[index] === "*" && value[index + 1] === "/")) index++
      if (index >= value.length) return false
      index += 2
      continue
    }
    return false
  }
  return true
}

function splitSingleSqlStatement(statement: string): string | undefined {
  let quote: "\"" | "'" | "`" | undefined
  let bracketIdentifier = false
  for (let index = 0; index < statement.length; index++) {
    const char = statement[index]
    const next = statement[index + 1]

    if (quote) {
      if (char === quote && next === quote) {
        index++
        continue
      }
      if (char === quote) quote = undefined
      continue
    }
    if (bracketIdentifier) {
      if (char === "]") bracketIdentifier = false
      continue
    }
    if (char === "-" && next === "-") {
      index += 2
      while (index < statement.length && statement[index] !== "\n" && statement[index] !== "\r") index++
      continue
    }
    if (char === "/" && next === "*") {
      index += 2
      while (index < statement.length && !(statement[index] === "*" && statement[index + 1] === "/")) index++
      if (index >= statement.length) return
      index++
      continue
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char
      continue
    }
    if (char === "[") {
      bracketIdentifier = true
      continue
    }
    if (char === ";") {
      return hasOnlyTrailingComments(statement.slice(index + 1))
        ? statement.slice(0, index).trim()
        : undefined
    }
  }
  const trimmed = statement.trim()
  return quote || bracketIdentifier || !trimmed ? undefined : trimmed
}

function stripSqlComments(statement: string) {
  let output = ""
  let quote: "\"" | "'" | "`" | undefined
  for (let index = 0; index < statement.length; index++) {
    const char = statement[index]
    const next = statement[index + 1]
    if (quote) {
      if (char === quote && next === quote) {
        index++
      }
      else if (char === quote) {
        quote = undefined
      }
      output += " "
      continue
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char
      output += " "
      continue
    }
    if (char === "-" && next === "-") {
      index += 2
      while (index < statement.length && statement[index] !== "\n" && statement[index] !== "\r") index++
      output += " "
      continue
    }
    if (char === "/" && next === "*") {
      index += 2
      while (index < statement.length && !(statement[index] === "*" && statement[index + 1] === "/")) index++
      if (index < statement.length) index++
      output += " "
      continue
    }
    output += char
  }
  return output
}

function isReadOnlyPragma(statement: string) {
  const match = /^\s*pragma\s+(?:(?:main|temp)\.)?([a-z_]+)\s*(?:\([^)]*\))?\s*$/i.exec(statement)
  return match ? ["foreign_key_list", "index_list", "table_info"].includes(match[1]!.toLowerCase()) : false
}

function normalizeReadSql(statement: unknown) {
  const single = splitSingleSqlStatement(assertString(statement, "db_query statement"))
  if (!single) return
  if (isReadOnlyPragma(single)) return single
  const normalized = stripSqlComments(single).trim()
  if (/^select\b/i.test(normalized)) return single
  if (!/^with\b/i.test(normalized)) return
  if (/\b(insert|update|delete|replace|create|drop|alter|vacuum|pragma|begin|commit|rollback|savepoint|release)\b/i.test(normalized)) return
  return /\bselect\b/i.test(normalized) ? single : undefined
}

function sqlKind(statement: string): "data" | "read" | "schema" | undefined {
  const normalized = stripSqlComments(statement).trim()
  if (/^(select|with)\b/i.test(normalized) || isReadOnlyPragma(normalized)) return "read"
  if (/^(alter|create|drop|reindex|vacuum)\b/i.test(normalized)) return "schema"
  if (/^(insert|update|delete|replace)\b/i.test(normalized)) return "data"
  return
}

function executeSql(database: unknown, statement: string): MaybePromise<unknown> {
  const execute = typeof database === "object" && database !== null ? (database as { execute?: unknown }).execute : undefined
  const run = typeof database === "object" && database !== null ? (database as { run?: unknown }).run : undefined
  if (typeof run === "function") return run.call(database, statement)
  if (typeof execute === "function") return execute.call(database, statement)
  throw new Error("[vitehub] db primitive must expose raw string execute() or run() for db_exec.")
}

function querySql(database: unknown, statement: string): MaybePromise<unknown> {
  const query = typeof database === "object" && database !== null ? (database as { query?: unknown }).query : undefined
  if (typeof query === "function") return query.call(database, statement)
  throw new Error("[vitehub] db primitive must expose raw string query() for db_query.")
}

function readDatabaseSchema(database: unknown, databaseName: string): unknown {
  const schemaFn = typeof database === "object" && database !== null ? (database as { schema?: unknown }).schema : undefined
  if (typeof schemaFn === "function") return schemaFn.call(database)
  const schema = typeof database === "object" && database !== null ? (database as { schema?: unknown }).schema : undefined
  return { database: databaseName, schema }
}

function kvTools(mode: AgentCapabilityMode, options: KVCapabilityOptions): AgentCapabilityDefinition["tools"] {
  return (context) => {
    const store = selectStore(requirePrimitive(context as never, "kv"), "KV", options.store)
    const tools: AgentToolSet = {
      kv_read: createTool<KVReadInput>({
        description: "Read one KV value by exact key or list KV keys under a developer-provided prefix.",
        execute: ({ key, prefix }: KVReadInput = {}) => {
          if (!hasExactlyOne(key, prefix)) throw new Error("[vitehub] kv_read requires exactly one of key or prefix.")
          if (typeof key === "string" && key.trim()) return method<(key: string) => MaybePromise<unknown>>(store, "kv", "get")(key)
          return method<(prefix: string) => MaybePromise<string[]>>(store, "kv", "keys")(assertString(prefix, "kv_read prefix"))
        },
        inputSchema: kvReadInputSchema,
        name: "kv_read",
      }),
    }
    if (mode === "write") {
      tools.kv_edit = createTool<KVEditInput>({
        description: "Put or delete one KV key.",
        execute: ({ key, operation, value }) => {
          assertString(key, "kv_edit key")
          if (operation === "put") return method<(key: string, value: unknown) => MaybePromise<unknown>>(store, "kv", "set")(key, value)
          if (operation === "delete") return method<(key: string) => MaybePromise<unknown>>(store, "kv", "del")(key)
          throw new Error(`[vitehub] Unsupported kv_edit operation: ${String(operation)}`)
        },
        inputSchema: kvEditInputSchema,
        name: "kv_edit",
        policy: options.policy || "require-approval",
      })
    }
    return tools
  }
}

function blobTools(mode: AgentCapabilityMode, options: BlobCapabilityOptions): AgentCapabilityDefinition["tools"] {
  return (context) => {
    const store = selectStore(requirePrimitive(context as never, "blob"), "Blob", options.store)
    const tools: AgentToolSet = {
      blob_read: createTool<BlobReadInput>({
        description: "Read one Blob object, read object metadata, or list objects under a developer-provided prefix.",
        execute: ({ cursor, folded, limit, operation, pathname, prefix }: BlobReadInput) => {
          if (operation === "get") return method<(pathname: string) => MaybePromise<unknown>>(store, "blob", "get")(assertString(pathname, "blob_read pathname"))
          if (operation === "head") return method<(pathname: string) => MaybePromise<unknown>>(store, "blob", "head")(assertString(pathname, "blob_read pathname"))
          if (operation === "list") {
            const scopedPrefix = assertString(prefix, "blob_read prefix")
            return method<(options?: unknown) => MaybePromise<unknown>>(store, "blob", "list")({ cursor, folded, limit: normalizeListLimit(limit), prefix: scopedPrefix })
          }
          throw new Error(`[vitehub] Unsupported blob_read operation: ${String(operation)}`)
        },
        inputSchema: blobReadInputSchema,
        name: "blob_read",
      }),
    }
    if (mode === "write") {
      tools.blob_edit = createTool<BlobEditInput>({
        description: "Put or delete Blob objects.",
        execute: ({ body, operation, options: putOptions, pathname }) => {
          if (operation === "put") return method<(pathname: string, body: unknown, options?: unknown) => MaybePromise<unknown>>(store, "blob", "put")(assertString(pathname, "blob_edit pathname"), body, putOptions)
          if (operation === "delete") {
            return method<(pathname: string) => MaybePromise<unknown>>(store, "blob", "del")(assertString(pathname, "blob_edit pathname"))
          }
          throw new Error(`[vitehub] Unsupported blob_edit operation: ${String(operation)}`)
        },
        inputSchema: blobEditInputSchema,
        name: "blob_edit",
        policy: options.policy || "require-approval",
      })
    }
    return tools
  }
}

function dbTools(mode: AgentCapabilityMode, schemaMode: AgentCapabilityMode, options: DBCapabilityOptions): AgentCapabilityDefinition["tools"] {
  return (context) => {
    const databaseName = options.database || "default"
    const database = selectDatabase(requirePrimitive(context as never, "db"), databaseName)
    const tools: AgentToolSet = {
      db_query: createTool<DbSqlInput>({
        description: "Run one read-only SQL query against the configured ViteHub database.",
        execute: async ({ statement }) => {
          const sql = normalizeReadSql(statement)
          if (!sql) throw new Error("[vitehub] db_query only accepts one SELECT, WITH ... SELECT, or read-only introspection PRAGMA statement.")
          return await querySql(database, sql)
        },
        inputSchema: dbQueryInputSchema,
        name: "db_query",
      }),
      db_schema: createTool({
        description: "Describe the configured ViteHub database schema.",
        execute: () => readDatabaseSchema(database, databaseName),
        name: "db_schema",
      }),
    }
    if (mode === "write" || schemaMode === "write") {
      tools.db_exec = createTool<DbExecInput>({
        description: "Run one SQL mutation against the configured ViteHub database. Requires rationale; DDL requires schema write mode.",
        execute: async ({ rationale, statement }) => {
          if (!rationale?.trim()) throw new Error("[vitehub] db_exec requires a rationale.")
          const sql = splitSingleSqlStatement(assertString(statement, "db_exec statement"))
          if (!sql) throw new Error("[vitehub] db_exec accepts exactly one SQL statement.")
          const kind = sqlKind(sql)
          if (kind === "read") throw new Error("[vitehub] db_exec does not accept read-only SQL; use db_query.")
          if (kind === "schema" && schemaMode !== "write") throw new Error("[vitehub] db_exec requires schemaMode: \"write\" for DDL statements.")
          if (kind === "data" && mode !== "write") throw new Error("[vitehub] db_exec requires mode: \"write\" for data mutation statements.")
          if (!kind) throw new Error("[vitehub] db_exec only accepts data mutation or DDL SQL statements.")
          return await executeSql(database, sql)
        },
        inputSchema: dbExecInputSchema,
        name: "db_exec",
        policy: options.policy || "require-approval",
      })
    }
    return tools
  }
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

export function kv(options: KVCapabilityOptions = {}): AgentCapabilityDefinition {
  const mode = normalizeMode(options.mode, "KV")
  return defineCapability({ id: "kv", mode, requires: [{ primitive: "kv" }], tools: kvTools(mode, options) })
}

export function blob(options: BlobCapabilityOptions = {}): AgentCapabilityDefinition {
  const mode = normalizeMode(options.mode, "Blob")
  return defineCapability({ id: "blob", mode, requires: [{ primitive: "blob" }], tools: blobTools(mode, options) })
}

export function db(options: DBCapabilityOptions = {}): AgentCapabilityDefinition {
  const mode = normalizeMode(options.mode, "DB")
  const schemaMode = normalizeMode(options.schemaMode, "DB schema")
  return defineCapability({ id: "db", mode, metadata: { schemaMode }, requires: [{ primitive: "db" }], tools: dbTools(mode, schemaMode, options) })
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

export function mcp(options: { servers?: Record<string, unknown> } = {}): AgentCapabilityDefinition {
  return defineCapability({
    id: "mcp",
    metadata: { servers: options.servers || {} },
  })
}

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
