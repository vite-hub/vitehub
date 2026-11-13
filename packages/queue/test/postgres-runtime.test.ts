import postgres from "postgres"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { closePostgresQueues, createPostgresQueueRuntimeClient, startPostgresQueue } from "../src/internal/runtime/postgres-client.ts"
import { setQueueRuntimeConfig, setQueueRuntimeRegistry } from "../src/internal/runtime/state.ts"
import { createPostgresQueueEngine } from "../src/providers/postgres.ts"
import { dynamicQueue } from "../src/runtime/client.ts"

import type { PostgresQueueEngine } from "../src/providers/postgres.ts"

vi.mock("../src/providers/postgres.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/providers/postgres.ts")>()
  return { ...actual, createPostgresQueueEngine: vi.fn(actual.createPostgresQueueEngine) }
})

const actual = await vi.importActual<typeof import("../src/providers/postgres.ts")>("../src/providers/postgres.ts")
const created: PostgresQueueEngine[] = []

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  vi.stubEnv("QUEUE_POSTGRES_URL", "postgres://localhost/queue?application_name=before")
  vi.mocked(createPostgresQueueEngine).mockImplementation((options) => {
    const engine = actual.createPostgresQueueEngine(options)
    vi.spyOn(engine, "start").mockResolvedValue()
    vi.spyOn(engine, "enqueue").mockResolvedValue(["message"])
    created.push(engine)
    return engine
  })
})

afterEach(async () => {
  await closePostgresQueues()
  setQueueRuntimeConfig(undefined)
  setQueueRuntimeRegistry(undefined)
  created.length = 0
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

it("rejects a connection replacement from a send whose Definition finishes loading during shutdown", async () => {
  const definition = gate()
  const loading = gate()
  const drain = gate()
  const draining = gate()
  const config = { provider: "postgres" } as const
  let holdDefinition = false
  setQueueRuntimeRegistry({ jobs: async () => {
    if (holdDefinition) { loading.resolve(); await definition.promise }
    return { handler() {} }
  } })
  setQueueRuntimeConfig(config, createPostgresQueueRuntimeClient)
  startPostgresQueue(config)
  const held = await dynamicQueue.use("jobs")
  holdDefinition = true
  const engine = created[0]!
  const close = engine.close.bind(engine)
  vi.spyOn(engine, "close").mockImplementation(async () => { draining.resolve(); await drain.promise; await close() })
  const send = dynamicQueue.send("jobs", "late")
  await loading.promise
  const shutdown = closePostgresQueues()
  await draining.promise
  try {
    vi.stubEnv("QUEUE_POSTGRES_URL", "postgres://localhost/queue?application_name=after")
    definition.resolve()
    expect((await send)[0]).toMatchObject({ code: "QUEUE_PROVIDER_FAILED", cause: { code: "QUEUE_POSTGRES_CLOSING" } })
    expect((await held.sendBatch([{ body: "late" }]))[0]).toMatchObject({ cause: { code: "QUEUE_POSTGRES_CLOSING" } })
    await expect(createPostgresQueueRuntimeClient({ ...config, database: "other", queue: "jobs" }))
      .rejects.toMatchObject({ code: "QUEUE_POSTGRES_CLOSING" })
    expect(created).toHaveLength(1)
  }
  finally {
    definition.resolve()
    drain.resolve()
    await shutdown
  }
  await closePostgresQueues()
  expect(engine.close).toHaveBeenCalledTimes(1)
})

it("does not publish a connection whose resolution was pending when shutdown began", async () => {
  const resolving = gate()
  const connection = gate()
  const replacement = postgres("postgres://localhost/queue")
  const config = { database: "default", provider: "postgres" } as const
  startPostgresQueue(config, async () => { resolving.resolve(); await connection.promise; return { default: { db: { $client: replacement } } } })
  await createPostgresQueueRuntimeClient({ ...config, queue: "jobs" })
  vi.stubEnv("QUEUE_POSTGRES_URL", "")
  const pending = createPostgresQueueRuntimeClient({ ...config, queue: "jobs" })
  await resolving.promise
  const result = expect(pending).rejects.toMatchObject({ code: "QUEUE_POSTGRES_CLOSING" })
  const shutdown = closePostgresQueues()
  connection.resolve()
  try {
    await result
  }
  finally {
    await shutdown
    await replacement.end()
  }
  expect(created).toHaveLength(1)
})
