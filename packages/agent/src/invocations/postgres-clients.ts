import { trackNodePostgresClient, trackPgliteClient, trackPostgresClient } from "@vite-hub/database/runtime/request-stats"

import { agentDiagnostics } from "../agent-diagnostics.ts"

import type { AgentInvocationPostgresClient, AgentInvocationPostgresQuery } from "./postgres-store.ts"

type PostgresRows = { rows: Array<Record<string, unknown>> }
type PostgresParameters = Parameters<AgentInvocationPostgresQuery["unsafe"]>[1]

interface RowsQuery {
  query(text: string, values?: PostgresParameters): Promise<PostgresRows>
}

interface NodePostgresPool extends RowsQuery {
  connect(): Promise<RowsQuery & { release(destroy?: boolean): void }>
  totalCount: number
}

interface Pglite extends RowsQuery {
  exec(text: string): Promise<unknown>
  transaction<T>(run: (transaction: RowsQuery) => Promise<T>): Promise<T>
}

function hasMethods(value: unknown, ...names: string[]): boolean {
  return (typeof value === "object" || typeof value === "function") && value !== null && names.every(name => typeof Reflect.get(value, name) === "function")
}

function isPostgresJs(value: unknown): value is AgentInvocationPostgresClient {
  return typeof value === "function" && hasMethods(value, "begin", "unsafe")
}

function isNodePostgresPool(value: unknown): value is NodePostgresPool {
  return hasMethods(value, "connect", "query") && typeof Reflect.get(Object(value), "totalCount") === "number"
}

function isPglite(value: unknown): value is Pglite {
  return hasMethods(value, "exec", "query", "transaction")
}

function rowsQuery(client: RowsQuery): AgentInvocationPostgresQuery {
  return { unsafe: async (query, parameters) => (await client.query(query, parameters)).rows }
}

function nodePostgresClient(pool: NodePostgresPool): AgentInvocationPostgresClient {
  return {
    ...rowsQuery(pool),
    async begin(run) {
      const connection = await pool.connect()
      let rollbackFailed = false
      try {
        await connection.query("BEGIN")
        try {
          const result = await run(rowsQuery(connection))
          await connection.query("COMMIT")
          return result
        }
        catch (error) {
          rollbackFailed = await connection.query("ROLLBACK").then(() => false, () => true)
          throw error
        }
      }
      finally {
        connection.release(rollbackFailed)
      }
    },
  }
}

function pgliteClient(pglite: Pglite): AgentInvocationPostgresClient {
  return {
    ...rowsQuery(pglite),
    begin: async run => await pglite.transaction(async transaction => await run(rowsQuery(transaction))),
  }
}

const clients = new WeakMap<object, AgentInvocationPostgresClient>()

/**
 * The journal client of a Postgres Database for its `$client`: postgres.js, a node-postgres Pool, or PGlite. Its queries
 * count in the request's database stats. Each driver client keeps one journal client, so the table check stays cached.
 * Another client, such as a single `pg.Client` that would run other queries inside a transaction, fails with
 * `AGENT_INVOCATIONS_POSTGRES_DRIVER_UNSUPPORTED`. A node-postgres transaction holds one pooled connection, and the
 * pool destroys a connection that cannot roll back.
 */
export function agentInvocationPostgresClient(client: unknown, database: string): AgentInvocationPostgresClient {
  if (!client || (typeof client !== "object" && typeof client !== "function")) {
    throw agentDiagnostics.AGENT_INVOCATIONS_POSTGRES_DRIVER_UNSUPPORTED({ database })
  }
  const cached = clients.get(client)
  if (cached) return cached
  let journal: AgentInvocationPostgresClient
  if (isPostgresJs(client)) journal = trackPostgresClient(client)
  else if (isNodePostgresPool(client)) journal = nodePostgresClient(trackNodePostgresClient(client))
  else if (isPglite(client)) journal = pgliteClient(trackPgliteClient(client))
  else throw agentDiagnostics.AGENT_INVOCATIONS_POSTGRES_DRIVER_UNSUPPORTED({ database })
  clients.set(client, journal)
  return journal
}
