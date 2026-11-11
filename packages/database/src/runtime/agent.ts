import { sql } from "drizzle-orm"
import { databaseErrorDiagnostics } from "../error-diagnostics.ts"

export interface AgentDatabaseHandle {
  exec(statement: string): Promise<unknown>
  query(statement: string): Promise<unknown>
  schema(): Promise<unknown>
}

interface AgentDatabaseEntry {
  db:
    | { execute(query: unknown): Promise<unknown> }
    | { all(query: unknown): Promise<unknown>, execute?: undefined, run(query: unknown): Promise<unknown> }
}

// Postgres databases run every statement through execute(). SQLite databases use all() and run().
const postgresSchemaQuery = "SELECT table_schema, table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema, table_name, ordinal_position"
const sqliteSchemaQuery = "SELECT name, type, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"

export function defaultDatabaseNotConfiguredError(): Error {
  return databaseErrorDiagnostics.DATABASE_NOT_FOUND({ database: "default" })
}

export function databaseNotFoundError(name: string): Error {
  return databaseErrorDiagnostics.DATABASE_NOT_FOUND({ database: name })
}

function requireDatabase(databases: Record<string, AgentDatabaseEntry>, name: string) {
  const entry = Object.hasOwn(databases, name) ? databases[name] : undefined
  if (!entry) throw databaseErrorDiagnostics.DATABASE_NOT_FOUND({ database: name })
  return entry
}

function createAgentDatabaseHandle(
  databases: Record<string, AgentDatabaseEntry>,
  name: string,
): AgentDatabaseHandle {
  function execute(statement: string, method: "all" | "run") {
    const { db } = requireDatabase(databases, name)
    const query = sql.raw(statement)
    return db.execute ? db.execute(query) : db[method](query)
  }

  return {
    exec: statement => execute(statement, "run"),
    query: statement => execute(statement, "all"),
    schema: () => {
      const { db } = requireDatabase(databases, name)
      return execute(db.execute ? postgresSchemaQuery : sqliteSchemaQuery, "all")
    },
  }
}

export function createAgentDatabase(databases: Record<string, AgentDatabaseEntry>) {
  return {
    ...createAgentDatabaseHandle(databases, "default"),
    database(name: string) {
      requireDatabase(databases, name)
      return createAgentDatabaseHandle(databases, name)
    },
  }
}

/**
 * The operations shared by a Cloudflare D1 binding and the request's D1 session with read replication.
 * Consumers such as the D1 Agent Invocation store accept this contract; it is not the full `D1Database` API.
 */
export interface DatabaseD1Binding {
  prepare(query: string): DatabaseD1Statement
  // doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- Matches Cloudflare D1's batch contract; the SQL decides the row shape.
  batch<T = Record<string, unknown>>(statements: DatabaseD1Statement[]): Promise<DatabaseD1Result<T>[]>
}

export interface DatabaseD1Statement {
  bind(...values: unknown[]): DatabaseD1Statement
  // doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- Matches Cloudflare D1's all contract; the SQL decides the row shape.
  all<T = Record<string, unknown>>(): Promise<DatabaseD1Result<T>>
  // doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- Matches Cloudflare D1's first contract; the SQL decides the row shape.
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>
  // doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- Matches Cloudflare D1's raw contract; the SQL decides the row shape.
  raw<T = unknown[]>(): Promise<T[]>
  // doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- Matches Cloudflare D1's run contract; the SQL decides the row shape.
  run<T = Record<string, unknown>>(): Promise<DatabaseD1Result<T>>
}

export interface DatabaseD1Result<T = Record<string, unknown>> {
  meta: { changes: number } & Record<string, unknown>
  results: T[]
  success: boolean
}

interface BindingDatabaseEntry {
  db: object
}

function isD1Binding(value: unknown): value is DatabaseD1Binding {
  return typeof value === "object" && value !== null
    && typeof Reflect.get(value, "prepare") === "function"
    && typeof Reflect.get(value, "batch") === "function"
}

/**
 * Return a lookup of the D1 binding of each Database. `db.$client` is the binding, or the request's D1 session with
 * read replication, so read it for each call. Throws `DATABASE_NOT_FOUND` for an unknown name and
 * `DATABASE_NO_D1_BINDING` when the Database does not run on a D1 binding here.
 */
export function createDatabaseBindingLookup(databases: Record<string, BindingDatabaseEntry>) {
  return (name: string): DatabaseD1Binding => {
    const entry = Object.hasOwn(databases, name) ? databases[name] : undefined
    if (!entry) throw databaseErrorDiagnostics.DATABASE_NOT_FOUND({ database: name })
    const client: unknown = Reflect.get(entry.db, "$client")
    if (!isD1Binding(client)) throw databaseErrorDiagnostics.DATABASE_NO_D1_BINDING({ database: name })
    return client
  }
}
