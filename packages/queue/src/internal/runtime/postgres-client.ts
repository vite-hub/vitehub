import { postgresQueueUrlVariable } from "../../config.ts"
import { createPostgresQueueClient, createPostgresQueueEngine, isPostgresQueueSql } from "../../providers/postgres.ts"
import { listQueueDefinitionNames, loadQueueDefinition, missingQueueDefinitionError, setQueueRuntimeJobStore } from "./state.ts"

import type { PostgresQueueConnection, PostgresQueueEngine } from "../../providers/postgres.ts"
import type { QueueClient } from "../../types.ts"
import type { QueueRuntimeOptions, QueueRuntimeProviderOptions } from "./types.ts"
import { queueErrorDiagnostics } from "../../error-diagnostics.ts"

/** The Databases of the app, as `@vite-hub/database/drizzle` exports them. */
export type PostgresQueueDatabases = Readonly<Record<string, { db: object } | undefined>>

/** Loads the Databases of the app. The generated server passes it when the jobs use the connection of a Database. */
export type PostgresQueueDatabasesLoader = () => Promise<PostgresQueueDatabases>

const postgresUrl = /^postgres(?:ql)?:\/\//i

let loadDatabases: PostgresQueueDatabasesLoader | undefined
// The generated server starts workers. A script with a direct client only sends.
let workers = false
// One engine per process, so every client shares the workers. A new connection replaces it.
let current: { engine: PostgresQueueEngine, key: object | string } | undefined
let pending: Promise<PostgresQueueEngine> | undefined

interface ResolvedConnection {
  connection: PostgresQueueConnection
  /** The URL, or the client of the Database. A Database can replace its client when its environment changes. */
  key: object | string
}

/**
 * The connection of the jobs: `QUEUE_POSTGRES_URL` when it is set, else the postgres.js client of the Database that the
 * build found on Postgres. The jobs then use the connection that the Database resolves, whatever variable it reads.
 */
export async function resolvePostgresQueueConnection(
  config: { database?: string },
  databases: PostgresQueueDatabasesLoader | undefined = loadDatabases,
  env: Record<string, string | undefined> = process.env,
): Promise<ResolvedConnection> {
  const url = env[postgresQueueUrlVariable]?.trim()
  if (url) {
    if (!postgresUrl.test(url)) throw queueErrorDiagnostics.QUEUE_POSTGRES_INVALID_URL({ variable: postgresQueueUrlVariable })
    return { connection: { url }, key: url }
  }
  if (config.database && databases) {
    const entry = (await databases())[config.database]
    const client: unknown = entry ? Reflect.get(entry.db, "$client") : undefined
    if (isPostgresQueueSql(client)) return { connection: { client }, key: client }
  }
  throw queueErrorDiagnostics.QUEUE_POSTGRES_MISSING_CONNECTION({ database: config.database })
}

async function getPostgresQueueEngine(config: { database?: string, development?: boolean }): Promise<PostgresQueueEngine> {
  // Wait for an engine that is starting, so two first sends do not start two engines.
  await pending?.catch(() => {})
  const { connection, key } = await resolvePostgresQueueConnection(config)
  if (current?.key === key) return current.engine
  const previous = current?.engine
  const engine = createPostgresQueueEngine({
    connection,
    development: config.development === true,
    load: loadQueueDefinition,
    missing: missingQueueDefinitionError,
    queues: listQueueDefinitionNames,
  })
  current = { engine, key }
  // The old engine finishes its running jobs and closes.
  void previous?.close()
  if (workers) {
    console.info(`[vitehub:queue] Queue uses the postgres provider. Jobs are in ${engine.base}. Every instance of the app takes jobs from it.`)
    engine.start().catch((error: unknown) => {
      console.error(`[vitehub:queue] The postgres provider cannot start the workers on ${engine.base}.`, error)
    })
  }
  return engine
}

function usePostgresQueueEngine(config: { database?: string, development?: boolean }): Promise<PostgresQueueEngine> {
  const engine = getPostgresQueueEngine(config)
  pending = engine
  return engine
}

export async function createPostgresQueueRuntimeClient(options: QueueRuntimeProviderOptions): Promise<QueueClient> {
  if (options.provider !== "postgres") {
    throw queueErrorDiagnostics.QUEUE_PROVIDER_MISMATCH({ expected: "postgres", provider: options.provider })
  }
  if (!options.queue) throw queueErrorDiagnostics.QUEUE_MISSING_QUEUE()
  return createPostgresQueueClient(await usePostgresQueueEngine(options), options.queue)
}

/**
 * Starts the workers when the server starts: this process takes the due jobs of every Queue Definition from Postgres.
 * `databases` loads the Databases of the app, for a build that found its Default Database on Postgres. Logs once where
 * the jobs are.
 */
export function startPostgresQueue(config: false | QueueRuntimeOptions, databases?: PostgresQueueDatabasesLoader): void {
  if (config === false || config.provider !== "postgres") return
  loadDatabases = databases
  workers = true
  setQueueRuntimeJobStore(() => usePostgresQueueEngine(config))
  usePostgresQueueEngine(config).catch((error: unknown) => {
    console.error("[vitehub:queue] The postgres provider cannot start the workers.", error)
  })
}

/** Stops taking jobs, waits for the running jobs up to 10 seconds, and closes the connections it opened. The jobs stay. */
export async function closePostgresQueues(): Promise<void> {
  await pending?.catch(() => {})
  const engine = current?.engine
  current = undefined
  pending = undefined
  loadDatabases = undefined
  workers = false
  setQueueRuntimeJobStore(undefined)
  await engine?.close()
}
