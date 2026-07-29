import { sql } from "drizzle-orm"

export interface AgentDatabaseHandle {
  exec(statement: string): Promise<unknown>
  query(statement: string): Promise<unknown>
  schema(): Promise<unknown>
}

interface AgentDatabaseEntry {
  db: {
    all(query: unknown): Promise<unknown>
    run(query: unknown): Promise<unknown>
  }
}

function requireDatabase(databases: Record<string, AgentDatabaseEntry>, name: string) {
  const entry = databases[name]
  if (!entry) throw new Error(`[vitehub] Database "${name}" is not configured.`)
  return entry
}

function createAgentDatabaseHandle(
  databases: Record<string, AgentDatabaseEntry>,
  name: string,
): AgentDatabaseHandle {
  return {
    exec: statement => requireDatabase(databases, name).db.run(sql.raw(statement)),
    query: statement => requireDatabase(databases, name).db.all(sql.raw(statement)),
    schema: () => requireDatabase(databases, name).db.all(sql.raw(
      "SELECT name, type, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )),
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
