import { eq, isTable, sql } from "drizzle-orm"
import { defineTool } from "@vitehub/agent"

import type { AgentToolDefinition, AgentToolSet } from "@vitehub/agent"

export type DbAgentToolAccess = "read" | "schema" | "write"

export type DbAgentToolDefinition<TInput = unknown, TOutput = unknown> = AgentToolDefinition<TInput, TOutput>
export type DbAgentToolSet = AgentToolSet

export interface DbAgentDatabaseEntry {
  db: Record<string, unknown>
  schema: Record<string, unknown>
}

export interface CreateDbToolsOptions {
  access?: DbAgentToolAccess
  database?: string
  databases?: Record<string, DbAgentDatabaseEntry>
  prefix?: string
}

type ResolvedCreateDbToolsOptions = CreateDbToolsOptions & {
  database: string
}

interface SelectInput {
  limit?: number
  offset?: number
  orderBy?: string
  table: string
}

interface InsertInput {
  table: string
  values: Record<string, unknown> | Array<Record<string, unknown>>
}

interface MatchInput {
  column: string
  table: string
  value: unknown
}

interface UpdateInput extends MatchInput {
  values: Record<string, unknown>
}

interface SchemaSqlInput {
  statement: string
}

const metadata = {
  category: "database",
  preset: "vitehub-db",
}

async function getDatabases(options: CreateDbToolsOptions) {
  if (options.databases) return options.databases
  const module = await import("./drizzle.ts")
  return module.databases as unknown as Record<string, DbAgentDatabaseEntry>
}

async function getDatabase(options: ResolvedCreateDbToolsOptions) {
  const databases = await getDatabases(options)
  const entry = databases[options.database]
  if (!entry) {
    throw new Error(`[vitehub] Database "${options.database}" is not configured.`)
  }
  return entry
}

function getTable(entry: DbAgentDatabaseEntry, tableName: string) {
  const table = entry.schema[tableName]
  if (!isTable(table)) {
    throw new Error(`[vitehub] Database table "${tableName}" was not found in the configured schema.`)
  }
  return table as unknown as Record<string, unknown>
}

function listTables(entry: DbAgentDatabaseEntry) {
  return Object.entries(entry.schema)
    .filter(([, value]) => isTable(value))
    .map(([name]) => name)
    .sort()
}

function getColumn(table: Record<string, unknown>, columnName: string) {
  const column = table[columnName]
  if (!column || typeof column !== "object") {
    throw new Error(`[vitehub] Database column "${columnName}" was not found on the selected table.`)
  }
  return column
}

function isReadStatement(statement: string) {
  if (!/^\s*select\b/i.test(statement)) return false

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
      if (index >= statement.length) return false
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
    }
  }

  return !quote && !bracketIdentifier
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

function tableProperty() {
  return {
    table: {
      description: "Schema export name for the target Drizzle table.",
      type: "string",
    },
  }
}

function toolKey(prefix: string, operation: string) {
  return `${prefix}_${operation}`
}

function sanitizeToolPrefix(value: string) {
  const sanitized = value
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()
  return sanitized || "db"
}

function resolveToolPrefix(options: ResolvedCreateDbToolsOptions) {
  if (options.prefix) return sanitizeToolPrefix(options.prefix)
  if (options.database === "default") return "db"
  return `${sanitizeToolPrefix(options.database)}_db`
}

function resolveDatabaseName(options: CreateDbToolsOptions): string {
  if (options.database) return options.database
  if (!options.databases) return "default"

  const names = Object.keys(options.databases)
  if (names.length === 0) return "default"
  if (names.length === 1 && names[0]) return names[0]

  throw new TypeError("[vitehub] createDbTools() requires a database name when multiple databases are configured.")
}

function readTools(options: ResolvedCreateDbToolsOptions, prefix: string): DbAgentToolSet {
  return {
    [toolKey(prefix, "list_tables")]: defineTool<Record<string, never>, { database: string, tables: string[] }>({
      description: `List schema table exports for the ${options.database} database.`,
      execute: async () => {
        const entry = await getDatabase(options)
        return { database: options.database, tables: listTables(entry) }
      },
      inputSchema: {
        additionalProperties: false,
        properties: {},
        type: "object",
      },
      metadata,
      name: toolKey(prefix, "list_tables"),
    }),
    [toolKey(prefix, "select")]: defineTool<SelectInput, unknown>({
      description: `Read rows from a Drizzle table in the ${options.database} database.`,
      execute: async ({ limit = 25, offset = 0, orderBy, table }) => {
        const entry = await getDatabase(options)
        const schemaTable = getTable(entry, table)
        let query = (entry.db.select as () => { from: (table: unknown) => unknown })().from(schemaTable)
        if (orderBy) {
          query = (query as { orderBy: (column: unknown) => unknown }).orderBy(getColumn(schemaTable, orderBy))
        }
        query = (query as { limit: (limit: number) => unknown }).limit(Math.min(Math.max(limit, 1), 100))
        query = (query as { offset: (offset: number) => unknown }).offset(Math.max(offset, 0))
        return await query
      },
      inputSchema: {
        additionalProperties: false,
        properties: {
          ...tableProperty(),
          limit: { maximum: 100, minimum: 1, type: "number" },
          offset: { minimum: 0, type: "number" },
          orderBy: { description: "Optional schema column export name to order ascending.", type: "string" },
        },
        required: ["table"],
        type: "object",
      },
      metadata,
      name: toolKey(prefix, "select"),
    }),
    [toolKey(prefix, "read_sql")]: defineTool<SchemaSqlInput, unknown>({
      description: `Run a read-only SQL statement through the ${options.database} database.`,
      execute: async ({ statement }) => {
        if (!isReadStatement(statement)) {
          throw new Error(`[vitehub] ${toolKey(prefix, "read_sql")} only accepts SELECT statements.`)
        }
        const entry = await getDatabase(options)
        return await (entry.db.all as (query: unknown) => Promise<unknown>)(sql.raw(statement))
      },
      inputSchema: {
        additionalProperties: false,
        properties: {
          statement: { description: "SELECT statement to execute.", type: "string" },
        },
        required: ["statement"],
        type: "object",
      },
      metadata,
      name: toolKey(prefix, "read_sql"),
    }),
  }
}

function writeTools(options: ResolvedCreateDbToolsOptions, prefix: string): DbAgentToolSet {
  return {
    [toolKey(prefix, "insert")]: defineTool<InsertInput, unknown>({
      description: `Insert seed-style rows through a Drizzle table in the ${options.database} database.`,
      execute: async ({ table, values }) => {
        const entry = await getDatabase(options)
        const schemaTable = getTable(entry, table)
        return await (entry.db.insert as (table: unknown) => { values: (values: unknown) => { returning: () => Promise<unknown> } })(schemaTable).values(values).returning()
      },
      inputSchema: {
        additionalProperties: false,
        properties: {
          ...tableProperty(),
          values: {
            oneOf: [
              { additionalProperties: true, type: "object" },
              { items: { additionalProperties: true, type: "object" }, type: "array" },
            ],
          },
        },
        required: ["table", "values"],
        type: "object",
      },
      metadata,
      name: toolKey(prefix, "insert"),
    }),
    [toolKey(prefix, "update")]: defineTool<UpdateInput, unknown>({
      description: `Update rows matching one equality condition through a Drizzle table in the ${options.database} database.`,
      execute: async ({ column, table, value, values }) => {
        const entry = await getDatabase(options)
        const schemaTable = getTable(entry, table)
        return await (entry.db.update as (table: unknown) => { set: (values: unknown) => { where: (condition: unknown) => { returning: () => Promise<unknown> } } })(schemaTable)
          .set(values)
          .where(eq(getColumn(schemaTable, column) as never, value))
          .returning()
      },
      inputSchema: {
        additionalProperties: false,
        properties: {
          ...tableProperty(),
          column: { description: "Schema column export name for the equality match.", type: "string" },
          value: { description: "Value to match in the equality condition." },
          values: { additionalProperties: true, type: "object" },
        },
        required: ["table", "column", "value", "values"],
        type: "object",
      },
      metadata,
      name: toolKey(prefix, "update"),
    }),
    [toolKey(prefix, "delete")]: defineTool<MatchInput, unknown>({
      description: `Delete rows matching one equality condition through a Drizzle table in the ${options.database} database.`,
      execute: async ({ column, table, value }) => {
        const entry = await getDatabase(options)
        const schemaTable = getTable(entry, table)
        return await (entry.db.delete as (table: unknown) => { where: (condition: unknown) => { returning: () => Promise<unknown> } })(schemaTable)
          .where(eq(getColumn(schemaTable, column) as never, value))
          .returning()
      },
      inputSchema: {
        additionalProperties: false,
        properties: {
          ...tableProperty(),
          column: { description: "Schema column export name for the equality match.", type: "string" },
          value: { description: "Value to match in the equality condition." },
        },
        required: ["table", "column", "value"],
        type: "object",
      },
      metadata,
      name: toolKey(prefix, "delete"),
    }),
  }
}

function schemaTools(options: ResolvedCreateDbToolsOptions, prefix: string): DbAgentToolSet {
  return {
    [toolKey(prefix, "run_schema_sql")]: defineTool<SchemaSqlInput, unknown>({
      description: `Run explicit runtime DDL SQL through the ${options.database} database.`,
      execute: async ({ statement }) => {
        const entry = await getDatabase(options)
        return await (entry.db.run as (query: unknown) => Promise<unknown>)(sql.raw(statement))
      },
      inputSchema: {
        additionalProperties: false,
        properties: {
          statement: { description: "DDL SQL statement to execute.", type: "string" },
        },
        required: ["statement"],
        type: "object",
      },
      metadata,
      name: toolKey(prefix, "run_schema_sql"),
      policy: "require-approval",
    }),
  }
}

export function createDbTools(options: CreateDbToolsOptions): DbAgentToolSet {
  if (!options || typeof options !== "object") {
    throw new TypeError("[vitehub] createDbTools() requires options.")
  }
  if (options.database !== undefined && typeof options.database !== "string") {
    throw new TypeError("[vitehub] createDbTools() database must be a string.")
  }
  const resolvedOptions = { ...options, database: resolveDatabaseName(options) }
  const prefix = resolveToolPrefix(resolvedOptions)
  const access = resolvedOptions.access || "read"
  if (access === "read") return readTools(resolvedOptions, prefix)
  if (access === "write") return { ...readTools(resolvedOptions, prefix), ...writeTools(resolvedOptions, prefix) }
  if (access === "schema") return { ...readTools(resolvedOptions, prefix), ...writeTools(resolvedOptions, prefix), ...schemaTools(resolvedOptions, prefix) }
  throw new TypeError(`[vitehub] Unknown DB agent tool access: ${String(access)}`)
}
