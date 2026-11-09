import { postgresQueueUrlVariables } from "../../config.ts"
import { createPostgresQueueClient, createPostgresQueueEngine } from "../../providers/postgres.ts"
import { listQueueDefinitionNames, loadQueueDefinition, missingQueueDefinitionError, setQueueRuntimeJobStore } from "./state.ts"

import type { PostgresQueueEngine } from "../../providers/postgres.ts"
import type { QueueClient } from "../../types.ts"
import type { QueueRuntimeOptions, QueueRuntimeProviderOptions } from "./types.ts"
import { queueErrorDiagnostics } from "../../error-diagnostics.ts"

const postgresUrl = /^postgres(?:ql)?:\/\//i

// One engine per process, so every client shares the workers and the connection pool.
let current: { engine: PostgresQueueEngine, url: string } | undefined

/** The connection URL from `QUEUE_POSTGRES_URL`, else `DATABASE_URL`. It is read when the server runs, not at build time. */
export function resolvePostgresQueueUrl(env: Record<string, string | undefined> = process.env): string {
  for (const name of postgresQueueUrlVariables) {
    const value = env[name]?.trim()
    if (!value) continue
    if (!postgresUrl.test(value)) throw queueErrorDiagnostics.QUEUE_POSTGRES_INVALID_URL({ variable: name })
    return value
  }
  throw queueErrorDiagnostics.QUEUE_POSTGRES_MISSING_URL()
}

function getPostgresQueueEngine(development: boolean | undefined): PostgresQueueEngine {
  const url = resolvePostgresQueueUrl()
  if (current?.url === url) return current.engine
  const previous = current?.engine
  const engine = createPostgresQueueEngine({
    development: development === true,
    load: loadQueueDefinition,
    missing: missingQueueDefinitionError,
    queues: listQueueDefinitionNames,
    url,
  })
  current = { engine, url }
  // A new URL replaces the engine. The old one finishes its running jobs and closes.
  void previous?.close()
  return engine
}

export async function createPostgresQueueRuntimeClient(options: QueueRuntimeProviderOptions): Promise<QueueClient> {
  if (options.provider !== "postgres") {
    throw queueErrorDiagnostics.QUEUE_PROVIDER_MISMATCH({ expected: "postgres", provider: options.provider })
  }
  if (!options.queue) throw queueErrorDiagnostics.QUEUE_MISSING_QUEUE()
  return createPostgresQueueClient(getPostgresQueueEngine(options.development), options.queue)
}

/**
 * Starts the workers when the server starts: this process takes the due jobs of every Queue Definition from Postgres.
 * Logs once where the jobs are.
 */
export function startPostgresQueue(config: false | QueueRuntimeOptions): void {
  if (config === false || config.provider !== "postgres") return
  let engine: PostgresQueueEngine
  try {
    engine = getPostgresQueueEngine(config.development)
  }
  catch (error) {
    console.error("[vitehub:queue] The postgres provider cannot start.", error)
    return
  }
  setQueueRuntimeJobStore(() => getPostgresQueueEngine(config.development))
  console.info(`[vitehub:queue] Queue uses the postgres provider. Jobs are in ${engine.base}. Every instance of the app takes jobs from it.`)
  engine.start().catch((error: unknown) => {
    console.error(`[vitehub:queue] The postgres provider cannot start the workers on ${engine.base}.`, error)
  })
}

/** Stops taking jobs, waits for the running jobs up to 10 seconds, and closes the connections. The jobs stay. */
export async function closePostgresQueues(): Promise<void> {
  const engine = current?.engine
  current = undefined
  setQueueRuntimeJobStore(undefined)
  await engine?.close()
}
