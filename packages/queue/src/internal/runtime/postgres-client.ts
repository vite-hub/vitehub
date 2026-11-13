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
let closing: Promise<void> | undefined
interface EngineState {
  current?: { engine: PostgresQueueEngine, key: object | string }
  pending?: Promise<PostgresQueueEngine>
  started?: PostgresQueueEngine
  workers: boolean
}

// Clients with the same configuration share delivery. Direct producers with other configurations only send.
const engines = new Map<string, EngineState>()
const retiring = new Set<Promise<void>>()
type EngineConfig = { database?: string, development?: boolean }

function assertOpen(): void {
  if (closing) throw queueErrorDiagnostics.QUEUE_POSTGRES_CLOSING()
}

function engineState(config: EngineConfig): EngineState {
  const key = JSON.stringify([config.database ?? null, config.development === true])
  let state = engines.get(key)
  if (!state) {
    state = { workers: false }
    engines.set(key, state)
  }
  return state
}

function startWorkers(state: EngineState, engine: PostgresQueueEngine) {
  if (!state.workers || state.started === engine) return
  state.started = engine
  console.info(`[vitehub:queue] Queue uses the postgres provider. Jobs are in ${engine.base}. Every instance of the app takes jobs from it.`)
  engine.start().catch((error: unknown) => {
    console.error(`[vitehub:queue] The postgres provider cannot start the workers on ${engine.base}.`, error)
  })
}

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

function usePostgresQueueEngine(config: EngineConfig): Promise<PostgresQueueEngine> {
  assertOpen()
  const state = engineState(config)
  // Serialize resolution too: concurrent sends must not replace each other's engine.
  const pending = (state.pending?.catch(() => {}) ?? Promise.resolve()).then(async () => {
    assertOpen()
    const { connection, key } = await resolvePostgresQueueConnection(config)
    assertOpen()
    if (state.current?.key === key) {
      startWorkers(state, state.current.engine)
      return state.current.engine
    }
    const previous = state.current?.engine
    const engine = createPostgresQueueEngine({
      connection,
      development: config.development === true,
      load: loadQueueDefinition,
      missing: missingQueueDefinitionError,
      queues: listQueueDefinitionNames,
      // Workers must follow Database replacement even without a local send or job operation.
      refreshConnection: async () => { await usePostgresQueueEngine(config) },
    })
    state.current = { engine, key }
    if (previous) {
      const closing = previous.close().catch((error: unknown) => {
        console.error("[vitehub:queue] The postgres provider cannot close its previous connection.", error)
      }).finally(() => retiring.delete(closing))
      retiring.add(closing)
    }
    startWorkers(state, engine)
    return engine
  })
  state.pending = pending
  return pending
}

export async function createPostgresQueueRuntimeClient(options: QueueRuntimeProviderOptions): Promise<QueueClient> {
  if (options.provider !== "postgres") {
    throw queueErrorDiagnostics.QUEUE_PROVIDER_MISMATCH({ expected: "postgres", provider: options.provider })
  }
  if (!options.queue) throw queueErrorDiagnostics.QUEUE_MISSING_QUEUE()
  return createPostgresQueueClient(await usePostgresQueueEngine(options), options.queue, () => usePostgresQueueEngine(options))
}

/**
 * Starts the workers when the server starts: this process takes the due jobs of every Queue Definition from Postgres.
 * `databases` loads the Databases of the app, for a build that found its Default Database on Postgres. Logs once where
 * the jobs are.
 */
export function startPostgresQueue(config: false | QueueRuntimeOptions, databases?: PostgresQueueDatabasesLoader): void {
  if (config === false || config.provider !== "postgres") return
  assertOpen()
  loadDatabases = databases
  engineState(config).workers = true
  setQueueRuntimeJobStore(() => usePostgresQueueEngine(config))
  usePostgresQueueEngine(config).catch((error: unknown) => {
    console.error("[vitehub:queue] The postgres provider cannot start the workers.", error)
  })
}

/** Stops taking jobs, waits for the running jobs up to 10 seconds, and closes the connections it opened. The jobs stay. */
export function closePostgresQueues(): Promise<void> {
  if (closing) return closing
  closing = (async () => {
    const states = [...engines.values()]
    for (const state of states) state.workers = false
    setQueueRuntimeJobStore(undefined)
    // Admission is closed before queued resolutions resume, so these sets cannot acquire new engines or retirements.
    await Promise.all(states.map(state => state.pending?.catch(() => {})))
    await Promise.all([...states.map(state => state.current?.engine.close()), ...retiring])
    engines.clear()
    loadDatabases = undefined
  })().finally(() => { closing = undefined })
  return closing
}
