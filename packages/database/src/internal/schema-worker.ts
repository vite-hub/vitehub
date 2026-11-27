import { parentPort, workerData } from "node:worker_threads"

import { loadDatabaseSchema } from "./schema-tables.ts"

import type { DatabaseSchemaWorkerMessage } from "./schema-tables.ts"

// SAFETY: `loadDatabaseSchemaInWorker()` passes this shape as `workerData`.
const { alias, fallback, handler } = workerData as { alias?: Record<string, string>, fallback: boolean, handler: string }
const fallbacks: string[] = []

function post(message: DatabaseSchemaWorkerMessage) {
  parentPort?.postMessage(message)
}

loadDatabaseSchema(handler, { alias, onFallback: fallback ? message => fallbacks.push(message) : undefined }).then(
  schema => post({ fallbacks, schema: { ...schema, sqlNames: [...schema.sqlNames] } }),
  (error: unknown) => post({ error: error instanceof Error ? error.message : String(error) }),
)
