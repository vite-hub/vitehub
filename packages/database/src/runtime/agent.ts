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
