import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { resolve } from "node:path"

import postgres from "postgres"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"

import { defineDatabase } from "@vite-hub/database"
import { createPostgresDatabase } from "../../database/src/runtime/postgres.ts"

import { queueUnsupportedOptionsError } from "../src/errors.ts"
import { closePostgresQueues, createPostgresQueueRuntimeClient, resolvePostgresQueueConnection, startPostgresQueue } from "../src/internal/runtime/postgres-client.ts"
import { getQueueRuntimeJobStore, setQueueRuntimeConfig, setQueueRuntimeRegistry } from "../src/internal/runtime/state.ts"
import { createLocalQueueRuntimeClient } from "../src/internal/runtime/local-client.ts"
import { dynamicQueue } from "../src/runtime/client.ts"
import { createQueueClient } from "../src/runtime/create-client.ts"
import { createPostgresQueueClient, createPostgresQueueEngine } from "../src/providers/postgres.ts"

import type { ChildProcess } from "node:child_process"
import type { PostgresQueueEngine, PostgresQueueEngineOptions } from "../src/providers/postgres.ts"
import type { QueueDefinition, QueueJob } from "../src/types.ts"

// Opt-in: `docker run --rm -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres:17`, then
// `VITEHUB_TEST_POSTGRES_URL=postgres://postgres:pw@127.0.0.1:5432/postgres vp test test/postgres.test.ts`.
const url = process.env.VITEHUB_TEST_POSTGRES_URL
const workerFile = resolve(import.meta.dirname, "fixtures/postgres-queue-worker.ts")

const sql = url ? postgres(url, { max: 4, onnotice: () => {} }) : undefined
const engines: PostgresQueueEngine[] = []
const children: ChildProcess[] = []
const tables: string[] = []

function createGate() {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function table(): string {
  const name = `q_${randomUUID().replaceAll("-", "").slice(0, 12)}`
  tables.push(name)
  return name
}

function engine(options: Partial<PostgresQueueEngineOptions> & { handler?: (job: QueueJob) => unknown, table: string }): PostgresQueueEngine {
  const definition: QueueDefinition = { handler: options.handler ?? (() => undefined) }
  const created = createPostgresQueueEngine({
    load: async () => definition,
    missing: queue => new Error(`No Queue Definition ${queue}`),
    pollIntervalMs: 100,
    queues: () => options.handler ? ["jobs"] : [],
    connection: { url: url! },
    ...options,
  })
  engines.push(created)
  return created
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (done(value)) return value
    if (Date.now() > deadline) throw new Error(`Timed out. Last value: ${JSON.stringify(value)}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

function startWorker(name: string, queueTable: string, lockSeconds = 30): Promise<ChildProcess> {
  const child = spawn(process.execPath, [workerFile], {
    env: { ...process.env, LOCK_SECONDS: String(lockSeconds), QUEUE_TABLE: queueTable, VITEHUB_TEST_POSTGRES_URL: url, WORKER_NAME: name },
    stdio: ["ignore", "pipe", "pipe"],
  })
  children.push(child)
  let output = ""
  return new Promise((resolve, reject) => {
    child.stderr!.on("data", (chunk: Buffer) => { output += chunk })
    child.stdout!.on("data", (chunk: Buffer) => {
      output += chunk
      if (output.includes("ready")) resolve(child)
    })
    child.once("exit", code => reject(new Error(`Worker ${name} exited with ${code}: ${output}`)))
  })
}

function exitCode(child: ChildProcess): Promise<number | null> {
  return child.exitCode !== null ? Promise.resolve(child.exitCode) : new Promise(resolve => child.once("exit", code => resolve(code)))
}

async function createRuns(queueTable: string) {
  await sql!`create table ${sql!(`${queueTable}_runs`)} (key text not null, worker text not null, attempts int not null, phase text not null)`
  tables.push(`${queueTable}_runs`)
}

afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL")
  await Promise.all(engines.splice(0).map(created => created.close()))
})

afterAll(async () => {
  if (!sql) return
  for (const name of tables) await sql`drop table if exists ${sql(name)}`
  await sql.end()
})

describe("postgres Queue connection", () => {
  const postgresDatabases = async () => ({ default: { db: { $client: postgres("postgres://user:secret@db.internal:5432/app") } } })

  it("uses the client of the Database, and QUEUE_POSTGRES_URL overrides it", async () => {
    const { connection } = await resolvePostgresQueueConnection({ database: "default" }, postgresDatabases, { DATABASE_URL: "postgres://other/unrelated" })
    expect("client" in connection).toBe(true)
    expect(await resolvePostgresQueueConnection({ database: "default" }, postgresDatabases, { QUEUE_POSTGRES_URL: "postgres://jobs/queue" }))
      .toMatchObject({ connection: { url: "postgres://jobs/queue" } })
  })

  it("does not read DATABASE_URL", async () => {
    await expect(resolvePostgresQueueConnection({}, undefined, { DATABASE_URL: "postgres://other/unrelated" }))
      .rejects.toMatchObject({ code: "QUEUE_POSTGRES_MISSING_CONNECTION" })
    // A SQLite Database has no postgres.js client.
    await expect(resolvePostgresQueueConnection({ database: "default" }, async () => ({ default: { db: {} } }), {}))
      .rejects.toMatchObject({ code: "QUEUE_POSTGRES_MISSING_CONNECTION" })
    await expect(resolvePostgresQueueConnection({ database: "default" }, postgresDatabases, { QUEUE_POSTGRES_URL: "libsql://jobs" }))
      .rejects.toMatchObject({ code: "QUEUE_POSTGRES_INVALID_URL" })
  })
})

describe.skipIf(!url)("postgres Queue provider", () => {
  it("creates the table once when several instances start at the same time", async () => {
    const name = table()
    const starts = Array.from({ length: 5 }, () => engine({ table: name }))
    await expect(Promise.all(starts.map(created => created.status()))).resolves.toHaveLength(5)
    const [{ count }] = await sql!<{ count: number }[]>`select count(*)::int as count from pg_tables where tablename = ${name}`
    expect(count).toBe(1)
  })

  it("runs a job once with its payload, then deletes it", async () => {
    const name = table()
    const ran: QueueJob[] = []
    const consumer = engine({ handler: job => void ran.push(job), table: name })
    await consumer.start()
    const client = createPostgresQueueClient(consumer, "jobs")
    const [error, sent] = await client.send({ hello: "world" }, { id: "msg-1" })
    expect(error).toBeUndefined()
    expect(sent).toEqual({ messageId: "msg-1", status: "queued" })
    const [, nullSent] = await client.send(null)
    const [, emptySent] = await client.send(undefined)
    await until(async () => ran.length, count => count === 3)
    expect(ran.find(job => job.id === "msg-1")).toEqual({ attempts: 1, id: "msg-1", payload: { hello: "world" } })
    expect(ran.find(job => job.id === nullSent!.messageId)?.payload).toBeNull()
    expect(ran.find(job => job.id === emptySent!.messageId)?.payload).toBeUndefined()
    await until(() => consumer.jobs(), jobs => jobs.length === 0)
  })

  it("rejects the enqueue options that the local provider rejects", async () => {
    const client = createPostgresQueueClient(engine({ table: table() }), "jobs")
    const [error] = await client.send({}, { contentType: "json" })
    expect(error?.code).toBe("QUEUE_UNSUPPORTED_OPTION")
  })

  it("limits running handlers even when the planner favors a nested loop", async () => {
    const name = table()
    const producer = engine({ table: name })
    const client = createPostgresQueueClient(producer, "jobs")
    await client.send(0)
    await sql!`alter table ${sql!(name)} set (autovacuum_enabled = false)`
    await sql!`analyze ${sql!(name)}`
    for (let offset = 1; offset < 200; offset += 100) {
      await client.sendBatch(Array.from({ length: Math.min(100, 200 - offset) }, (_, index) => ({ body: offset + index })))
    }
    const connection = postgres(url!, {
      max: 1,
      connection: {
        enable_hashjoin: "off", enable_mergejoin: "off", enable_material: "off", enable_hashagg: "off", enable_sort: "off",
      },
    })
    const gate = createGate()
    let active = 0
    let peak = 0
    const handler = async () => {
      peak = Math.max(peak, ++active)
      await gate.promise
      active--
    }
    const consumer = engine({
      connection: { client: connection },
      handler,
      load: async () => ({ options: { concurrency: 2 }, handler }),
      table: name,
    })
    try {
      await consumer.start()
      await until(async () => peak, count => count > 0)
      expect(peak).toBe(2)
      expect(await consumer.jobs({ state: "running" })).toHaveLength(2)
    }
    finally {
      const closed = consumer.close()
      gate.resolve()
      await closed
      await connection.end()
    }
  })

  it("keeps an expired local delivery tracked when renewals fail", async () => {
    const name = table()
    const gate = createGate()
    const started: QueueJob[] = []
    const handler = async (job: QueueJob) => {
      started.push(job)
      await gate.promise
    }
    const consumer = engine({ handler, load: async () => ({ options: { concurrency: 2 }, handler }), lockSeconds: 1, table: name })
    await consumer.status()
    // Fail only renewals; claims and completion writes still work.
    await sql!.unsafe(`create function ${name}_reject_renew() returns trigger language plpgsql as $$
      begin
        if new.status = 'running' and new.attempts = old.attempts then
          raise exception 'renew unavailable';
        end if;
        return new;
      end $$`)
    await sql!.unsafe(`create trigger reject_renew before update on ${name} for each row execute function ${name}_reject_renew()`)
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      await consumer.start()
      await createPostgresQueueClient(consumer, "jobs").send({})
      await until(async () => started.length, count => count > 0)
      // Several polls after the claim expires must not start the same job again locally.
      await new Promise(resolve => setTimeout(resolve, 1500))
      expect(errors).toHaveBeenCalledWith(expect.stringContaining("cannot renew"), expect.any(Error))
      expect(started).toHaveLength(1)
      expect((await consumer.jobs())[0]?.attempts).toBe(1)
      let drained = false
      const closed = consumer.close().then(() => { drained = true })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(drained).toBe(false)
      gate.resolve()
      await closed
      const [{ count }] = await sql!<{ count: number }[]>`select count(*)::int as count from ${sql!(name)}`
      expect(count).toBe(0)
    }
    finally {
      gate.resolve()
      await consumer.close()
      errors.mockRestore()
      await sql!.unsafe(`drop function ${name}_reject_renew() cascade`)
    }
  })

  it.each(["complete", "retry", "dead"] as const)("does not %s or renew a superseded claim with the same worker ID", async (outcome) => {
    const name = table()
    const gate = createGate()
    let started = false
    const consumer = engine({
      handler: async () => {
        started = true
        await gate.promise
        if (outcome === "dead") throw queueUnsupportedOptionsError({ contentType: "json" }, "postgres")
        if (outcome !== "complete") throw new Error("handler failed")
      },
      lockSeconds: 1,
      table: name,
      workerId: "reused-worker",
    })
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {})
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      await consumer.start()
      await createPostgresQueueClient(consumer, "jobs").send({})
      await until(async () => started, value => value)
      // A newer claim can belong to the same named worker. The attempt identifies the delivery.
      await sql!`update ${sql!(name)} set attempts = 2, locked_until = now() + interval '60 seconds'`
      await new Promise(resolve => setTimeout(resolve, 500))
      gate.resolve()
      await consumer.close()
      expect(warnings).toHaveBeenCalledWith(expect.stringContaining("lost the claim"))
      const rows = await sql!`select status, attempts, locked_by, locked_until > now() + interval '30 seconds' as held from ${sql!(name)}`
      expect(rows).toEqual([expect.objectContaining({ status: "running", attempts: 2, locked_by: "reused-worker", held: true })])
    }
    finally {
      gate.resolve()
      await consumer.close()
      warnings.mockRestore()
      errors.mockRestore()
    }
  })

  it("honors delaySeconds", async () => {
    const name = table()
    const ranAt: number[] = []
    const consumer = engine({ handler: () => void ranAt.push(Date.now()), table: name })
    await consumer.start()
    const sentAt = Date.now()
    await createPostgresQueueClient(consumer, "jobs").send({}, { delaySeconds: 2 })
    expect((await consumer.jobs())[0]).toMatchObject({ state: "pending" })
    await until(async () => ranAt.length, count => count === 1, 10_000)
    expect(ranAt[0]! - sentAt).toBeGreaterThanOrEqual(1900)
    expect(ranAt[0]! - sentAt).toBeLessThan(4000)
  })

  it("dedupes jobs with the same idempotencyKey while the first one is live", async () => {
    const name = table()
    const producer = engine({ table: name })
    const client = createPostgresQueueClient(producer, "jobs")
    const [, first] = await client.send({ n: 1 }, { delaySeconds: 60, idempotencyKey: "order-1" })
    const [, second] = await client.send({ n: 2 }, { delaySeconds: 60, idempotencyKey: "order-1" })
    const [, batch] = await client.sendBatch([{ body: { n: 3 }, idempotencyKey: "order-2" }, { body: { n: 4 }, idempotencyKey: "order-2" }, { body: { n: 5 }, idempotencyKey: "order-1" }], { delaySeconds: 60 })
    expect(second?.messageId).toBe(first?.messageId)
    expect(batch![1]!.messageId).toBe(batch![0]!.messageId)
    expect(batch![2]!.messageId).toBe(first?.messageId)
    expect(await producer.jobs()).toHaveLength(2)
    expect((await producer.job(first!.messageId!))?.payload).toEqual({ n: 1 })
    // Another Queue Definition has its own keys.
    const [, other] = await createPostgresQueueClient(producer, "other").send({}, { delaySeconds: 60, idempotencyKey: "order-1" })
    expect(other?.messageId).not.toBe(first?.messageId)
  })

  it("stores no job of a batch that breaks a rule", async () => {
    const producer = engine({ table: table() })
    const [error] = await createPostgresQueueClient(producer, "jobs").sendBatch([{ body: 1 }, { body: 2, delaySeconds: -1 }])
    expect(error?.code).toBe("QUEUE_PROVIDER_FAILED")
    expect(await producer.jobs()).toEqual([])
  })

  it("retries with backoff, keeps a dead job after 4 attempts, and retries it on request", async () => {
    const name = table()
    const attempts: number[] = []
    let fail = true
    const consumer = engine({
      handler: (job) => {
        attempts.push(job.attempts)
        if (fail) throw new Error("boom")
      },
      retryDelayMs: () => 100,
      table: name,
    })
    await consumer.start()
    const [, sent] = await createPostgresQueueClient(consumer, "jobs").send({ key: 1 })
    const id = sent!.messageId!
    await until(() => consumer.jobs({ state: "dead" }), jobs => jobs.length === 1)
    expect(attempts).toEqual([1, 2, 3, 4])
    const dead = await consumer.job(id)
    expect(dead).toMatchObject({ attempts: 4, error: { message: "[vitehub] Queue Delivery failed." }, payload: { key: 1 }, state: "dead" })
    expect(dead?.failedAt).toEqual(expect.any(String))
    expect(await consumer.status()).toMatchObject({ durability: "shared", queues: { jobs: { dead: 1, pending: 0, running: 0 } } })

    fail = false
    expect(await consumer.retry(id)).toMatchObject({ attempts: 0, state: "pending" })
    await until(() => consumer.jobs(), jobs => jobs.length === 0)
    expect(attempts.at(-1)).toBe(1)
    expect(await consumer.retry(id)).toBe("missing")
  })

  it("runs jobs on the connection of a Database whose URL comes from another variable", async () => {
    const saved = { DATABASE_URL: process.env.DATABASE_URL, QUEUE_POSTGRES_URL: process.env.QUEUE_POSTGRES_URL }
    tables.push("vitehub_queue_jobs")
    // An unrelated DATABASE_URL on a closed port: Queue must not use it.
    process.env.DATABASE_URL = "postgres://nobody:nothing@127.0.0.1:1/unrelated"
    delete process.env.QUEUE_POSTGRES_URL
    process.env.VITEHUB_TEST_QUEUE_DATABASE_URL = url
    const definition = defineDatabase({ connection: { url: { kind: "env-variable", source: { kind: "env", name: "VITEHUB_TEST_QUEUE_DATABASE_URL" } } }, dialect: "postgresql", schema: {} })
    const db = createPostgresDatabase(definition, { binding: "DB" })
    const ran: QueueJob[] = []
    setQueueRuntimeRegistry({ jobs: async () => ({ handler: (job: QueueJob) => void ran.push(job) }) })
    try {
      startPostgresQueue({ database: "default", provider: "postgres" }, async () => ({ default: { db } }))
      const client = await createPostgresQueueRuntimeClient({ database: "default", provider: "postgres", queue: "jobs" })
      const [error] = await client.send({ n: 1 })
      expect(error).toBeUndefined()
      await client.send({ n: 2 }, { delaySeconds: 60 })
      await until(async () => ran.length, count => count === 1, 10_000)
      expect(ran[0]?.payload).toEqual({ n: 1 })
      // The Drizzle client returns timestamps as text. The job list still has ISO times.
      const store = await getQueueRuntimeJobStore()
      expect(store?.base).toBe(`postgres://${new URL(url!).hostname}:${new URL(url!).port}${new URL(url!).pathname} (table vitehub_queue_jobs)`)
      const [pending] = await store!.jobs()
      expect(pending?.availableAt).toBe(new Date(pending!.availableAt).toISOString())
      expect(Date.parse(pending!.availableAt) - Date.now()).toBeGreaterThan(50_000)
    }
    finally {
      await closePostgresQueues()
      setQueueRuntimeRegistry(undefined)
      Object.assign(process.env, saved)
      if (saved.DATABASE_URL === undefined) delete process.env.DATABASE_URL
      if (saved.QUEUE_POSTGRES_URL === undefined) delete process.env.QUEUE_POSTGRES_URL
      // The Database owns its client. Queue leaves it open.
      await expect(db.execute("select 1")).resolves.toBeDefined()
      await Reflect.get(db, "$client").end()
    }
  })

  it.each(["send", "job operation", "worker poll"])("follows Database connection replacement through %s", async (refresh) => {
    tables.push("vitehub_queue_jobs")
    vi.stubEnv("QUEUE_POSTGRES_URL", undefined)
    vi.stubEnv("VITEHUB_TEST_QUEUE_DATABASE_URL", url!)
    const definition = defineDatabase({ connection: { url: { kind: "env-variable", source: { kind: "env", name: "VITEHUB_TEST_QUEUE_DATABASE_URL" } } }, dialect: "postgresql", schema: {} })
    const db = createPostgresDatabase(definition, { binding: "DB" })
    const queue = `connection_${randomUUID()}`
    const ran: unknown[] = []
    const config = { database: "default", provider: "postgres" } as const
    setQueueRuntimeRegistry({ [queue]: async () => ({ handler: (job: QueueJob) => void ran.push(job.payload) }) })
    setQueueRuntimeConfig(config, createPostgresQueueRuntimeClient)
    try {
      startPostgresQueue(config, async () => ({ default: { db } }))
      const held = await dynamicQueue.use(queue)
      expect((await held.send("before"))[0]).toBeUndefined()
      await until(async () => ran, values => values.includes("before"))
      const previous = Reflect.get(db, "$client")
      const replacement = new URL(url!)
      replacement.searchParams.set("application_name", `queue-${randomUUID()}`)
      process.env.VITEHUB_TEST_QUEUE_DATABASE_URL = replacement.href
      await db.execute("select 1")
      expect(Reflect.get(db, "$client")).not.toBe(previous)
      await previous.end()

      if (refresh === "job operation") await (await getQueueRuntimeJobStore())!.jobs()
      if (refresh === "worker poll") {
        // Another instance enqueues, so no local send or job operation can refresh this worker.
        const producer = engine({ connection: { client: sql! }, table: "vitehub_queue_jobs" })
        await createPostgresQueueClient(producer, queue).send("external")
        await until(async () => ran, values => values.includes("external"), 8000)
      }
      expect(await dynamicQueue.use(queue)).toBe(held)
      expect((await held.send("held"))[0]).toBeUndefined()
      expect((await dynamicQueue.send(queue, "named"))[0]).toBeUndefined()
      expect((await held.sendBatch([{ body: "batch" }]))[0]).toBeUndefined()
      await until(async () => ran, values => ["held", "named", "batch"].every(value => values.includes(value)), 8000)
    }
    finally {
      await closePostgresQueues()
      setQueueRuntimeConfig(undefined)
      setQueueRuntimeRegistry(undefined)
      await Reflect.get(db, "$client").end()
      vi.unstubAllEnvs()
    }
  }, 15_000)

  it.each(["standalone", "local app"])("creates a send-only direct Postgres client in a %s", async (mode) => {
    tables.push("vitehub_queue_jobs")
    vi.stubEnv("QUEUE_POSTGRES_URL", url!)
    const queue = `direct_${randomUUID()}`
    const factory = vi.fn(createLocalQueueRuntimeClient)
    const handler = vi.fn()
    setQueueRuntimeRegistry({ [queue]: async () => ({ handler }) })
    if (mode === "local app") setQueueRuntimeConfig({ provider: "local" }, factory)
    try {
      const client = await createQueueClient({ provider: "postgres", queue })
      expect((await client.send("one"))[0]).toBeUndefined()
      expect((await client.sendBatch([{ body: "two" }]))[0]).toBeUndefined()
      await new Promise(resolve => setTimeout(resolve, 1200))
      expect(factory).not.toHaveBeenCalled()
      expect(handler).not.toHaveBeenCalled()
      const rows = await sql!`select status, attempts from vitehub_queue_jobs where queue = ${queue}`
      expect(rows).toEqual([{ status: "pending", attempts: 0 }, { status: "pending", attempts: 0 }])
    }
    finally {
      await closePostgresQueues()
      setQueueRuntimeConfig(undefined)
      setQueueRuntimeRegistry(undefined)
      vi.unstubAllEnvs()
    }
  })

  it("reports a dead job whose idempotency key a newer live job holds", async () => {
    const consumer = engine({ handler: () => { throw new Error("boom") }, retryDelayMs: () => 50, table: table() })
    await consumer.start()
    const client = createPostgresQueueClient(consumer, "jobs")
    const [, dead] = await client.send({}, { idempotencyKey: "order-1" })
    await until(() => consumer.jobs({ state: "dead" }), jobs => jobs.length === 1)
    await client.send({}, { delaySeconds: 60, idempotencyKey: "order-1" })
    expect(await consumer.retry(dead!.messageId!)).toBe("duplicate")
  })

  it("clears pending and dead jobs, and keeps running jobs", async () => {
    const name = table()
    const producer = engine({ table: name })
    const client = createPostgresQueueClient(producer, "jobs")
    await client.sendBatch([{ body: 1 }, { body: 2 }], { delaySeconds: 60 })
    await createPostgresQueueClient(producer, "other").send(3, { delaySeconds: 60 })
    expect(await producer.clear({ queue: "other" })).toBe(1)
    expect(await producer.clear({ state: "dead" })).toBe(0)
    expect(await producer.clear()).toBe(2)
  })

  it("drains a running job when it closes", async () => {
    const name = table()
    let started = false
    let finished = false
    const consumer = engine({
      async handler() {
        started = true
        await new Promise(resolve => setTimeout(resolve, 500))
        finished = true
      },
      table: name,
    })
    await consumer.start()
    await createPostgresQueueClient(consumer, "jobs").send({})
    await until(async () => started, value => value)
    expect(await consumer.jobs({ state: "running" })).toHaveLength(1)
    await consumer.close()
    expect(finished).toBe(true)
    const [{ count }] = await sql!<{ count: number }[]>`select count(*)::int as count from ${sql!(name)}`
    expect(count).toBe(0)
  })

  it("renews during drain, then lets another worker reclaim after the deadline", async () => {
    const name = table()
    const gate = createGate()
    const nextGate = createGate()
    const firstRuns: QueueJob[] = []
    const nextRuns: QueueJob[] = []
    const first = engine({
      connection: { client: sql! }, drainTimeoutMs: 1200, lockSeconds: 1, table: name,
      handler: async (job) => { firstRuns.push(job); await gate.promise },
    })
    const next = engine({
      lockSeconds: 1, table: name,
      handler: async (job) => { nextRuns.push(job); await nextGate.promise },
    })
    try {
      await first.start()
      const [, sent] = await createPostgresQueueClient(first, "jobs").send({})
      await until(async () => firstRuns.length, count => count === 1)
      const closing = first.close()
      await new Promise(resolve => setTimeout(resolve, 1050))
      const [duringDrain] = await sql!`select locked_until > now() as held from ${sql!(name)}`
      expect(duringDrain!.held).toBe(true)
      await closing
      await expect(sql!`select 1`).resolves.toBeDefined()
      await next.start()
      await until(async () => nextRuns.length, count => count === 1, 4000)
      expect(nextRuns[0]).toMatchObject({ attempts: 2, id: sent!.messageId })
      gate.resolve()
      await new Promise(resolve => setTimeout(resolve, 100))
      // A late completion from the closed worker cannot acknowledge the replacement claim.
      expect(await next.job(sent!.messageId!)).toMatchObject({ attempts: 2, state: "running" })
      nextGate.resolve()
      await until(() => next.jobs(), jobs => jobs.length === 0)
    }
    finally {
      gate.resolve()
      nextGate.resolve()
      await Promise.all([first.close(), next.close()])
    }
  }, 10_000)

  it("runs 1,000 jobs exactly once over 3 processes", async () => {
    const name = table()
    const producer = engine({ table: name })
    await producer.status()
    await createRuns(name)
    const workers = await Promise.all(["a", "b", "c"].map(worker => startWorker(worker, name)))
    const client = createPostgresQueueClient(producer, "jobs")
    const keys = Array.from({ length: 1000 }, (_, index) => `job-${index}`)
    for (let start = 0; start < keys.length; start += 100) {
      const [error] = await client.sendBatch(keys.slice(start, start + 100).map(key => ({ body: { key } })))
      expect(error).toBeUndefined()
    }
    const read = async () => (await sql!<{ distinct: number, total: number }[]>`select count(*)::int as total, count(distinct key)::int as distinct
      from ${sql!(`${name}_runs`)} where phase = 'done'`)[0]!
    await until(read, value => value.distinct === 1000, 60_000)
    // Wait for a late second run, if any.
    await new Promise(resolve => setTimeout(resolve, 1000))
    expect(await read()).toEqual({ distinct: 1000, total: 1000 })
    const [{ starts }] = await sql!<{ starts: number }[]>`select count(*)::int as starts from ${sql!(`${name}_runs`)} where phase = 'start'`
    expect(starts).toBe(1000)
    const byWorker = await sql!<{ count: number, worker: string }[]>`select worker, count(*)::int as count from ${sql!(`${name}_runs`)}
      where phase = 'done' group by worker order by worker`
    expect(byWorker.map(row => row.worker)).toEqual(["a", "b", "c"])
    for (const row of byWorker) expect(row.count).toBeGreaterThan(0)
    // SIGTERM drains and exits cleanly.
    for (const worker of workers) worker.kill("SIGTERM")
    expect(await Promise.all(workers.map(exitCode))).toEqual([0, 0, 0])
  }, 120_000)

  it("runs the job of a killed worker on another worker after its claim ends", async () => {
    const name = table()
    const producer = engine({ table: name })
    await producer.status()
    await createRuns(name)
    const first = await startWorker("first", name, 2)
    await createPostgresQueueClient(producer, "jobs").send({ hold: true, key: "held" })
    const runs = () => sql!<{ attempts: number, phase: string, worker: string }[]>`select worker, attempts, phase from ${sql!(`${name}_runs`)} order by attempts, phase desc`
    await until(runs, rows => rows.length === 1)
    first.kill("SIGKILL")
    await exitCode(first)
    const killedAt = Date.now()
    await startWorker("second", name, 2)
    await until(runs, rows => rows.some(row => row.phase === "done"), 20_000)
    // The claim of the killed worker lasts 2 seconds from its last renewal.
    expect(Date.now() - killedAt).toBeLessThan(10_000)
    expect(await runs()).toEqual([
      { attempts: 1, phase: "start", worker: "first" },
      { attempts: 2, phase: "start", worker: "second" },
      { attempts: 2, phase: "done", worker: "second" },
    ])
  }, 60_000)
})
