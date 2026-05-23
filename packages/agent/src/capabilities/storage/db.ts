import {
  assertString,
  createTool,
  jsonObjectSchema,
  requirePrimitive,
  selectDatabase,
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

export function dbTools(mode: AgentCapabilityMode, schemaMode: AgentCapabilityMode, options: DBCapabilityOptions): AgentCapabilityDefinition["tools"] {
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
