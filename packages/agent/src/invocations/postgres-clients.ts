import { trackNodePostgresClient, trackPgliteClient, trackPostgresClient } from "@vite-hub/database/runtime/request-stats"

import { agentDiagnostics } from "../agent-diagnostics.ts"

import type { AgentInvocationPostgresClient, AgentInvocationPostgresQuery } from "./postgres-store.ts"

type PostgresRows = { rows: Array<Record<string, unknown>> }
type PostgresParameters = Parameters<AgentInvocationPostgresQuery["unsafe"]>[1]

interface RowsQuery {
  query(text: string, values?: PostgresParameters): Promise<PostgresRows>
}

interface NodePostgresConnection extends RowsQuery {
  on(event: "error", listener: (error: Error) => void): void
  removeListener(event: "error", listener: (error: Error) => void): void
  release(destroy?: boolean): void
}

interface NodePostgresPool extends RowsQuery {
  connect(): Promise<NodePostgresConnection>
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
      let connectionError: Error | undefined
      let rollbackFailed = false
      const onError = (error: Error) => { connectionError ??= error }
      connection.on("error", onError)
      try {
        await connection.query("BEGIN")
        if (connectionError) throw connectionError
        const result = await run(rowsQuery(connection))
        if (connectionError) throw connectionError
        await connection.query("COMMIT")
        if (connectionError) throw connectionError
        return result
      }
      catch (error) {
        if (!connectionError) {
          rollbackFailed = await connection.query("ROLLBACK").then(() => false, () => true)
        }
        throw error
      }
      finally {
        connection.release(connectionError !== undefined || rollbackFailed)
        connection.removeListener("error", onError)
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

/** `unsupported` is the error for a client that is not postgres.js, a node-postgres Pool, or PGlite. */
export function agentInvocationPostgresClient(client: unknown, database: string, unsupported: (input: { database: string }) => Error = agentDiagnostics.AGENT_INVOCATIONS_POSTGRES_DRIVER_UNSUPPORTED): AgentInvocationPostgresClient {
  if (!client || (typeof client !== "object" && typeof client !== "function")) {
    throw unsupported({ database })
  }
  const cached = clients.get(client)
  if (cached) return cached
  let journal: AgentInvocationPostgresClient
  if (isPostgresJs(client)) journal = trackPostgresClient(client)
  else if (isNodePostgresPool(client)) journal = nodePostgresClient(trackNodePostgresClient(client))
  else if (isPglite(client)) journal = pgliteClient(trackPgliteClient(client))
  else throw unsupported({ database })
  clients.set(client, journal)
  return journal
}
