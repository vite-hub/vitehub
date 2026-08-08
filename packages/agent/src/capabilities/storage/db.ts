import { defineCapability, normalizeMode } from "../../capability-runtime.ts"
import { loadAgentWorkflowDatabaseModule } from "../../internal/workflow-runtime-loaders.ts"
import {
  assertString,
  createTool,
  jsonObjectSchema,
  requirePrimitive,
} from "./shared.ts"
import {
  normalizeReadSql,
  splitSingleSqlStatement,
  sqlKind,
} from "./sql.ts"

import type {
  AgentCapabilityDefinition,
  AgentCapabilityMode,
  AgentToolSet,
  MaybePromise,
} from "../../types.ts"
import type { StorageToolPolicy } from "./shared.ts"

export interface DBCapabilityOptions {
  database?: string
  mode?: AgentCapabilityMode
  policy?: StorageToolPolicy
  schemaMode?: AgentCapabilityMode
}

export function db(options: DBCapabilityOptions = {}): AgentCapabilityDefinition {
  const mode = normalizeMode(options.mode, "DB")
  const schemaMode = normalizeMode(options.schemaMode, "DB schema")
  return defineCapability({ id: "db", mode, metadata: { schemaMode }, requires: [{ primitive: "db" }], tools: dbTools(mode, schemaMode, options) })
}

interface AgentDatabaseHandle {
  exec?: (statement: string) => MaybePromise<unknown>
  query?: (statement: string) => MaybePromise<unknown>
  schema?: Record<string, unknown> | (() => MaybePromise<unknown>)
}

interface AgentDatabasePrimitive extends AgentDatabaseHandle {
  database?: (name: string) => unknown
}

interface DbSqlInput {
  statement: string
}

interface DbExecInput extends DbSqlInput {
  rationale: string
}

const dbQueryInputSchema = jsonObjectSchema({
  statement: { type: "string" },
}, ["statement"])

const dbExecInputSchema = jsonObjectSchema({
  rationale: { type: "string" },
  statement: { type: "string" },
}, ["statement", "rationale"])

async function resolveDatabasePrimitive(context: Parameters<typeof requirePrimitive>[0]) {
  if (context.capabilities?.db !== undefined) return requirePrimitive(context, "db")
  const workflowDatabase = loadAgentWorkflowDatabaseModule()
  if (!workflowDatabase) return requirePrimitive(context, "db")
  try {
    return (await workflowDatabase).agentDb
  }
  catch (error) {
    throw new Error(`[vitehub] Capability "db" requires the database primitive to be configured or @vite-hub/database to be installed. ${error instanceof Error ? error.message : String(error)}`)
  }
}

function executeSql(database: unknown, statement: string): MaybePromise<unknown> {
  const handle = asAgentDatabaseHandle(database)
  if (handle && typeof handle.exec === "function") return handle.exec.call(handle, statement)
  throw new Error("[vitehub] db primitive must expose raw string exec() for db_exec.")
}

function querySql(database: unknown, statement: string): MaybePromise<unknown> {
  const handle = asAgentDatabaseHandle(database)
  if (handle && typeof handle.query === "function") return handle.query.call(handle, statement)
  throw new Error("[vitehub] db primitive must expose raw string query() for db_query.")
}

async function readDatabaseSchema(database: unknown, databaseName: string): Promise<unknown> {
  const handle = asAgentDatabaseHandle(database)
  const schema = typeof handle?.schema === "function"
    ? await handle.schema.call(handle)
    : handle?.schema
  return {
    database: databaseName,
    schema,
  }
}

function asAgentDatabaseHandle(value: unknown): AgentDatabaseHandle | undefined {
  return typeof value === "object" && value !== null ? value as AgentDatabaseHandle : undefined
}

function selectAgentDatabase(handle: unknown, database = "default"): unknown {
  const primitive = typeof handle === "object" && handle !== null ? handle as AgentDatabasePrimitive : undefined
  if (!primitive) return handle
  if (typeof primitive.database === "function") return primitive.database(database)
  if (database !== "default") {
    throw new Error(`[vitehub] Database "${database}" is not available.`)
  }
  return handle
}

function dbTools(mode: AgentCapabilityMode, schemaMode: AgentCapabilityMode, options: DBCapabilityOptions): AgentCapabilityDefinition["tools"] {
  return async (context) => {
    const databaseName = options.database || "default"
    const database = selectAgentDatabase(await resolveDatabasePrimitive(context as never), databaseName)
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
        execute: async () => await readDatabaseSchema(database, databaseName),
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
        policy: options.policy,
      })
    }
    return tools
  }
}
