import { randomUUID } from "node:crypto"
import { hostname } from "node:os"

import postgres from "postgres"

import { createQueueMessageId, normalizeQueueEnqueueInput } from "../enqueue.ts"
import { queueProviderResult, queueUnsupportedOptionsError } from "../errors.ts"
import { createQueueDeliveryErrorReport, isNonRetryableQueueError, reportQueueDeliveryError } from "../internal/delivery-error.ts"
import { checkQueueHandlerResponse } from "../internal/handler-response.ts"
import { delayMs, localQueueDeadLimit, localQueueDeliveryRules } from "./local.ts"

import type { LocalQueueClearFilter, LocalQueueDeliveryRules, LocalQueueJob, LocalQueueJobDetail, LocalQueueStatus, PostgresQueueClient, QueueDefinition, QueueDeliveryErrorDetails, QueueJobsFilter, QueueJobStore } from "../types.ts"
import type { LocalQueueEntry } from "./local.ts"

/** The table of the jobs. All Queue Definitions of the app share it. */
export const postgresQueueTable = "vitehub_queue_jobs"

/** Seconds that a claim holds a job. A running job renews it; a claim that is not renewed can be taken again. */
export const postgresQueueLockSeconds = 30

/** Milliseconds between two checks for due jobs. A send on any instance wakes the workers at once with `NOTIFY`. */
export const postgresQueuePollIntervalMs = 1000

/** Milliseconds that `close()` waits for running jobs. */
export const postgresQueueDrainTimeoutMs = 10_000

/** Jobs that `jobs()` lists at most. */
const listLimit = 1000

type DeliveryError = QueueDeliveryErrorDetails

/** A postgres.js client. */
export type PostgresQueueSql = postgres.Sql

/**
 * Where the jobs are. `client` borrows the postgres.js client of the app's Database, which keeps owning it. `url` opens
 * a client that the engine owns and closes.
 */
export type PostgresQueueConnection = { client: PostgresQueueSql } | { url: string }

export interface PostgresQueueEngineOptions {
  connection: PostgresQueueConnection
  /** `vite dev` sets this. A stored job error then keeps the message and stack of a plain `Error`. */
  development?: boolean
  /** Milliseconds that `close()` waits for running jobs. Defaults to 10 seconds. */
  drainTimeoutMs?: number
  load: (queue: string) => Promise<QueueDefinition | undefined>
  /** Seconds that a claim holds a job before another worker can take it. Defaults to 30. */
  lockSeconds?: number
  missing: (queue: string) => Error
  /** Milliseconds between two checks for due jobs. Defaults to 1 second. */
  pollIntervalMs?: number
  /** The Queue Definitions whose jobs this process runs. */
  queues: () => readonly string[]
  /** Rechecks a runtime-owned connection before workers poll for jobs. */
  refreshConnection?: () => Promise<void>
  /** Milliseconds before the next delivery after `attempts` failed deliveries. Defaults to the local rules. */
  retryDelayMs?: (attempts: number) => number
  /** Table of the jobs. Defaults to `vitehub_queue_jobs`. */
  table?: string
  /** Name of this worker in `locked_by`. Defaults to the host name, the process ID, and a random suffix. */
  workerId?: string
}

export interface PostgresQueueEngine extends QueueJobStore {
  readonly provider: "postgres"
  /** Stops taking jobs, waits up to `drainTimeoutMs` for the running jobs, and closes the connections it opened. */
  close: () => Promise<void>
  /** Inserts the jobs in one transaction and returns their message IDs. A job with the key of a live job returns its ID. */
  enqueue: (queue: string, entries: readonly LocalQueueEntry[]) => Promise<string[]>
  /** Creates the table and starts to take jobs. Later calls return the same promise. */
  start: () => Promise<void>
  readonly workerId: string
}

// Times are ISO strings: the Drizzle client of a Database returns timestamps as Postgres text, not as `Date`.
interface JobRow {
  attempts: number
  created_at: string
  failed_at: string | null
  id: string
  idempotency_key: string | null
  last_error: DeliveryError | null
  locked: boolean
  message_id: string
  /** `send()` got no payload. Postgres.js reads SQL `null` and JSON `null` both as `null`. */
  no_payload?: boolean
  payload?: unknown
  queue: string
  run_at: string
  status: "dead" | "pending" | "running"
}

const identifier = /^[a-z_][a-z\d_]{0,62}$/

/** Returns `true` for a postgres.js client, such as the `$client` of a Postgres Database. */
export function isPostgresQueueSql(value: unknown): value is PostgresQueueSql {
  return typeof value === "function"
    && ["begin", "end", "listen", "unsafe"].every(name => typeof Reflect.get(value, name) === "function")
}

/** The host, port, and database of the client without credentials, for logs, `vitehub queue list`, and the Console. */
export function describePostgresQueueLocation(sql: PostgresQueueSql, table: string): string {
  const { database, host, port } = sql.options
  const hosts = host.map((name, index) => `${name}${port[index] ? `:${port[index]}` : ""}`).join(",")
  return `postgres://${hosts}/${database} (table ${table})`
}

const iso = (date: string) => new Date(date).toISOString()

function toJobSummary(row: JobRow): LocalQueueJob {
  return {
    attempts: row.attempts,
    availableAt: iso(row.run_at),
    enqueuedAt: iso(row.created_at),
    ...(row.last_error ? { error: row.last_error } : {}),
    ...(row.failed_at ? { failedAt: iso(row.failed_at) } : {}),
    id: row.message_id,
    queue: row.queue,
    // A claim that ran out can be taken again, even if its previous handler is still running.
    state: row.status === "running" && !row.locked ? "pending" : row.status,
  }
}

export function createPostgresQueueEngine(options: PostgresQueueEngineOptions): PostgresQueueEngine {
  const table = options.table ?? postgresQueueTable
  // Internal invariant: only the Queue runtime and its tests choose this private SQL table name.
  if (!identifier.test(table)) throw new TypeError(`The Queue table name "${table}" must be a lowercase SQL identifier.`)
  const rules: LocalQueueDeliveryRules = localQueueDeliveryRules.postgres
  const retryDelayMs = options.retryDelayMs ?? rules.retryDelayMs
  const lockSeconds = options.lockSeconds ?? postgresQueueLockSeconds
  const pollIntervalMs = options.pollIntervalMs ?? postgresQueuePollIntervalMs
  const drainTimeoutMs = options.drainTimeoutMs ?? postgresQueueDrainTimeoutMs
  const workerId = options.workerId ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`
  const channel = table
  const ownsClient = "url" in options.connection
  // Postgres prints a notice for each `if not exists` that skips. The jobs need no notices.
  const sql = "url" in options.connection ? postgres(options.connection.url, { onnotice: () => {} }) : options.connection.client
  const base = describePostgresQueueLocation(sql, table)
  const t = sql(table)
  // `to_json()` writes a timestamp in ISO 8601, whatever parsers the client has.
  const times = sql`to_json(run_at) #>> '{}' as run_at, to_json(created_at) #>> '{}' as created_at, to_json(failed_at) #>> '{}' as failed_at`

  const running = new Map<string, Promise<void>>()
  const renewals = new Set<ReturnType<typeof setInterval>>()
  const runningPerQueue = new Map<string, number>()
  const concurrency = new Map<string, number>()
  let ready: Promise<void> | undefined
  let started: Promise<void> | undefined
  let unlisten: (() => Promise<void>) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let pumping: Promise<void> | undefined
  let pumpAgain = false
  let closed = false

  /** Creates the table once per process. Concurrent cold starts wait for one transaction lock, so they do not race. */
  function ensureTable(): Promise<void> {
    ready ??= (async () => {
      try {
        await sql`select 1 from ${t} limit 0`
        return
      }
      catch {}
      await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${`vitehub:queue:${table}`}))`
        await tx`create table if not exists ${t} (
          id uuid primary key,
          message_id text not null,
          queue text not null,
          payload jsonb,
          status text not null default 'pending' check (status in ('pending', 'running', 'dead')),
          attempts integer not null default 0,
          run_at timestamptz not null default now(),
          locked_until timestamptz,
          locked_by text,
          idempotency_key text,
          last_error jsonb,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          failed_at timestamptz
        )`
        // A live job holds its idempotency key. A dead job does not, and a completed job is deleted.
        await tx`create unique index if not exists ${sql(`${table}_idempotency`)} on ${t} (queue, idempotency_key) where idempotency_key is not null and status <> 'dead'`
        await tx`create index if not exists ${sql(`${table}_due`)} on ${t} (queue, run_at) where status <> 'dead'`
        await tx`create index if not exists ${sql(`${table}_message`)} on ${t} (message_id)`
      })
    })().catch((error: unknown) => {
      ready = undefined
      throw error
    })
    return ready
  }

  function arm(ms: number) {
    if (timer) clearTimeout(timer)
    timer = undefined
    if (closed) return
    timer = setTimeout(wake, ms)
    // A server keeps the process alive. The poll timer alone does not.
    timer.unref?.()
  }

  function wake() {
    if (closed) return
    if (pumping) {
      pumpAgain = true
      return
    }
    pumping = pump()
  }

  async function queueConcurrency(queue: string): Promise<number | undefined> {
    const known = concurrency.get(queue)
    if (known !== undefined) return known
    const definition = await options.load(queue)
    if (!definition) return undefined
    const limit = Number(definition.options?.concurrency ?? 1)
    const value = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1
    concurrency.set(queue, value)
    return value
  }

  /** Takes due jobs while a Queue Definition has a free slot, and starts them. */
  async function pump() {
    let wait = pollIntervalMs
    try {
      if (closed) return
      await options.refreshConnection?.()
      if (closed) return
      await ensureTable()
      for (const queue of options.queues()) {
        if (closed) return
        const limit = await queueConcurrency(queue).catch((error: unknown) => {
          console.error(`[vitehub:queue] The postgres provider cannot load the Queue Definition "${queue}".`, error)
          return undefined
        })
        if (limit === undefined) continue
        const free = limit - (runningPerQueue.get(queue) ?? 0)
        if (free <= 0) continue
        for (const row of await claim(queue, free)) start(row)
      }
    }
    catch (error) {
      wait = Math.max(wait, 5000)
      console.error(`[vitehub:queue] The postgres provider cannot read the jobs in ${base}. It tries again in ${Math.round(wait / 1000)} s.`, error)
    }
    finally {
      queueMicrotask(() => {
        pumping = undefined
        if (pumpAgain && !closed) {
          pumpAgain = false
          wake()
        }
        else {
          arm(wait)
        }
      })
    }
  }

  async function claim(queue: string, limit: number): Promise<JobRow[]> {
    // Evaluate the locking LIMIT once, even when the planner favors a nested loop.
    return await sql<JobRow[]>`
      with next_jobs as materialized (
        select id as claim_id from ${t}
        where queue = ${queue} and run_at <= now() and (status = 'pending' or (status = 'running' and locked_until < now()))
        ${running.size ? sql`and id not in ${sql([...running.keys()])}` : sql``}
        order by run_at, created_at
        for update skip locked
        limit ${limit}
      )
      update ${t} set status = 'running', attempts = attempts + 1, locked_by = ${workerId},
        locked_until = now() + make_interval(secs => ${lockSeconds}), updated_at = now()
      from next_jobs where id = next_jobs.claim_id
      returning id, message_id, queue, payload, payload is null as no_payload, attempts, status, ${times}, last_error, idempotency_key, true as locked`
  }

  function start(row: JobRow) {
    runningPerQueue.set(row.queue, (runningPerQueue.get(row.queue) ?? 0) + 1)
    const delivery = deliver(row).finally(() => {
      running.delete(row.id)
      runningPerQueue.set(row.queue, (runningPerQueue.get(row.queue) ?? 1) - 1)
      wake()
    })
    running.set(row.id, delivery)
  }

  async function pruneDead(queue: string) {
    await sql`delete from ${t} where id in (
      select id from ${t} where queue = ${queue} and status = 'dead' order by failed_at desc offset ${localQueueDeadLimit}
    )`
  }

  async function markDead(row: JobRow, error: DeliveryError, reason: string) {
    const result = await sql`update ${t} set status = 'dead', last_error = ${JSON.stringify(error)}::text::jsonb, failed_at = now(), locked_by = null,
      locked_until = null, updated_at = now() where id = ${row.id} and locked_by = ${workerId} and attempts = ${row.attempts}`
    if (!result.count) return
    console.error(`[vitehub:queue] The postgres provider stopped delivery of a "${row.queue}" job ${reason}. The job stays in ${base}.`)
    await pruneDead(row.queue)
  }

  async function deliver(row: JobRow) {
    // A claim counts the attempt before the handler runs. A job above the limit lost its last attempt to a stopped
    // process, for example a handler that crashes the process, so it does not run again.
    if (row.attempts > rules.maxAttempts) {
      await markDead(row, { message: "[vitehub] The process stopped during the last attempt of this job.", name: "Error" }, `after ${row.attempts - 1} attempts`)
        .catch((error: unknown) => console.error(`[vitehub:queue] The postgres provider cannot update a job in ${base}.`, error))
      return
    }
    // Renew while the handler runs. A failed renewal can let another worker take the job.
    let handling = true
    const renew = setInterval(() => {
      void sql`update ${t} set locked_until = now() + make_interval(secs => ${lockSeconds}), updated_at = now()
        where id = ${row.id} and locked_by = ${workerId} and attempts = ${row.attempts}`.then((result) => {
        if (!result.count && handling) {
          clearInterval(renew)
          renewals.delete(renew)
          console.warn(`[vitehub:queue] The postgres provider lost the claim of a "${row.queue}" job ${row.message_id}. Another delivery may be running.`)
        }
      }).catch((error: unknown) => {
        console.error(`[vitehub:queue] The postgres provider cannot renew the claim of a "${row.queue}" job.`, error)
      })
    }, Math.max(250, lockSeconds * 1000 / 3))
    renewals.add(renew)
    renew.unref?.()
    let failure: { error: unknown } | undefined
    try {
      const definition = await options.load(row.queue)
      if (!definition) throw options.missing(row.queue)
      checkQueueHandlerResponse(await definition.handler({ attempts: row.attempts, id: row.message_id, payload: row.no_payload ? undefined : row.payload }))
    }
    catch (error) {
      failure = { error }
    }
    finally {
      handling = false
      clearInterval(renew)
      renewals.delete(renew)
    }
    try {
      if (!failure) {
        await sql`delete from ${t} where id = ${row.id} and locked_by = ${workerId} and attempts = ${row.attempts}`
        return
      }
      const context = { attempts: row.attempts, development: options.development, id: row.message_id, provider: "postgres", queue: row.queue } as const
      reportQueueDeliveryError(failure.error, context)
      const report = createQueueDeliveryErrorReport(failure.error, context).error
      if (isNonRetryableQueueError(failure.error) || row.attempts >= rules.maxAttempts) {
        await markDead(row, report, `after ${row.attempts} attempts`)
        return
      }
      // A pending job keeps its last error, so `vitehub queue jobs list` shows why it waits.
      await sql`update ${t} set status = 'pending', run_at = now() + make_interval(secs => ${retryDelayMs(row.attempts) / 1000}),
        last_error = ${JSON.stringify(report)}::text::jsonb, locked_by = null, locked_until = null, updated_at = now()
        where id = ${row.id} and locked_by = ${workerId} and attempts = ${row.attempts}`
    }
    catch (storeError) {
      // The claim runs out, and another worker takes the job again.
      console.error(`[vitehub:queue] The postgres provider cannot update a job in ${base}. The job runs again when its claim ends.`, storeError)
    }
  }

  const columns = sql`id, message_id, queue, attempts, status, ${times}, last_error, idempotency_key,
    (status = 'running' and locked_until >= now()) as locked`

  async function findJob(id: string, payload: boolean): Promise<JobRow | undefined> {
    await ensureTable()
    const [row] = await sql<JobRow[]>`select ${columns}${payload ? sql`, payload, payload is null as no_payload` : sql``} from ${t}
      where message_id = ${id} order by created_at desc limit 1`
    return row
  }

  async function notify(queue: string) {
    await sql`select pg_notify(${channel}, ${queue})`
  }

  return {
    base,
    async clear(filter: LocalQueueClearFilter = {}) {
      await ensureTable()
      const state = filter.state === "dead"
        ? sql`status = 'dead'`
        : filter.state === "pending"
          ? sql`(status = 'pending' or (status = 'running' and locked_until < now()))`
          : sql`not (status = 'running' and locked_until >= now())`
      const result = await sql`delete from ${t} where ${state}${filter.queue === undefined ? sql`` : sql` and queue = ${filter.queue}`}`
      return result.count
    },
    async close() {
      if (closed) return
      closed = true
      if (timer) clearTimeout(timer)
      timer = undefined
      // A listener that is still starting must also be released.
      await started
      // A claim in progress adds its jobs to `running` before it ends.
      await pumping
      // Jobs that do not end in time keep their claim. Another instance runs them again when the claim ends.
      let drainTimer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        Promise.allSettled(running.values()),
        new Promise<void>((resolve) => {
          drainTimer = setTimeout(resolve, drainTimeoutMs)
        }),
      ])
      clearTimeout(drainTimer)
      // Keep leases alive during the drain, but let unfinished claims expire after its deadline.
      for (const renew of renewals) clearInterval(renew)
      renewals.clear()
      if (running.size) console.warn(`[vitehub:queue] The postgres provider stopped with ${running.size} running job${running.size === 1 ? "" : "s"}. Another instance runs ${running.size === 1 ? "it" : "them"} again in ${lockSeconds} s.`)
      await unlisten?.().catch(() => {})
      // A borrowed client belongs to the Database, which keeps using it.
      if (ownsClient) await sql.end({ timeout: 5 })
    },
    async enqueue(queue, entries) {
      // Check every job before one is stored, so a send that breaks a rule stores nothing.
      const prepared = entries.map((entry) => {
        const text = JSON.stringify(entry.payload)
        return { delaySeconds: delayMs(entry.delaySeconds, rules) / 1000, entry, text }
      })
      await ensureTable()
      const ids = await sql.begin(async (tx) => {
        const accepted: string[] = []
        for (const { delaySeconds, entry, text } of prepared) {
          // The update on a conflict changes nothing. It locks the live job and returns its ID.
          const [row] = await tx<{ message_id: string }[]>`
            insert into ${t} (id, message_id, queue, payload, run_at, idempotency_key)
            values (${randomUUID()}, ${entry.id}, ${queue}, ${text === undefined ? null : text}::text::jsonb,
              now() + make_interval(secs => ${delaySeconds}), ${entry.idempotencyKey ?? null})
            on conflict (queue, idempotency_key) where idempotency_key is not null and status <> 'dead'
            do update set updated_at = ${t}.updated_at
            returning message_id`
          accepted.push(row!.message_id)
        }
        // Postgres sends the notification when the transaction commits.
        await tx`select pg_notify(${channel}, ${queue})`
        return accepted
      })
      return ids
    },
    async job(id): Promise<LocalQueueJobDetail | undefined> {
      const row = await findJob(id, true)
      if (!row) return undefined
      return {
        ...toJobSummary(row),
        ...(row.idempotency_key === null ? {} : { idempotencyKey: row.idempotency_key }),
        ...(row.no_payload ? {} : { payload: row.payload }),
      }
    },
    async jobs(filter: QueueJobsFilter = {}) {
      await ensureTable()
      const state = filter.state === "running"
        ? sql` and status = 'running' and locked_until >= now()`
        : filter.state === "pending"
          ? sql` and (status = 'pending' or (status = 'running' and locked_until < now()))`
          : filter.state === "dead" ? sql` and status = 'dead'` : sql``
      const rows = await sql<JobRow[]>`select ${columns} from ${t}
        where true${filter.queue === undefined ? sql`` : sql` and queue = ${filter.queue}`}${state}
        order by created_at desc limit ${listLimit}`
      return rows.map(toJobSummary)
    },
    provider: "postgres",
    async retry(id) {
      const row = await findJob(id, false)
      if (!row) return "missing"
      if (row.locked) return "running"
      let updated: JobRow | undefined
      try {
        [updated] = row.status === "dead"
          ? await sql<JobRow[]>`update ${t} set status = 'pending', attempts = 0, last_error = null, failed_at = null,
              run_at = now(), updated_at = now() where id = ${row.id} and status = 'dead' returning ${columns}`
          : await sql<JobRow[]>`update ${t} set run_at = now(), updated_at = now()
              where id = ${row.id} and not (status = 'running' and locked_until >= now()) returning ${columns}`
      }
      catch (error) {
        // A newer live job holds the idempotency key of this dead job.
        if (error instanceof postgres.PostgresError && error.code === "23505") return "duplicate"
        throw error
      }
      if (!updated) return "running"
      await notify(row.queue)
      return toJobSummary(updated)
    },
    rules,
    start() {
      if (closed) return Promise.resolve()
      started ??= (async () => {
        try {
          const listener = await sql.listen(channel, () => wake())
          unlisten = listener.unlisten
        }
        catch (error) {
          console.warn(`[vitehub:queue] The postgres provider cannot LISTEN on ${base}. It checks for jobs every ${pollIntervalMs} ms.`, error)
        }
        wake()
      })()
      return started
    },
    async status(): Promise<LocalQueueStatus> {
      await ensureTable()
      const rows = await sql<{ dead: number, pending: number, queue: string, running: number }[]>`select queue,
        count(*) filter (where status = 'dead')::int as dead,
        count(*) filter (where status = 'running' and locked_until >= now())::int as running,
        count(*) filter (where status = 'pending' or (status = 'running' and locked_until < now()))::int as pending
        from ${t} group by queue`
      const queues: LocalQueueStatus["queues"] = {}
      for (const { queue, ...counts } of rows) queues[queue] = counts
      return { base, deadLimit: localQueueDeadLimit, durability: "shared", queues }
    },
    workerId,
  }
}

export function createPostgresQueueClient(engine: PostgresQueueEngine, queue: string, resolveEngine?: () => Promise<PostgresQueueEngine>): PostgresQueueClient {
  let activeEngine = engine
  async function enqueue(entries: readonly LocalQueueEntry[]) {
    const current = resolveEngine ? await resolveEngine() : engine
    activeEngine = current
    return await current.enqueue(queue, entries)
  }
  return {
    provider: "postgres",
    get native() { return activeEngine },
    queue,
    async send(payload, options) {
      const normalized = normalizeQueueEnqueueInput(payload, options)
      const optionsError = queueUnsupportedOptionsError(normalized.options, "postgres", engine.rules.unsupportedOptions)
      if (optionsError) return [optionsError, undefined]
      const [error, ids] = await queueProviderResult("postgres", "send", () => enqueue([{
        delaySeconds: normalized.options.delaySeconds,
        id: normalized.id,
        idempotencyKey: normalized.options.idempotencyKey,
        payload: normalized.payload,
      }]))
      if (error) return [error, undefined]
      return [undefined, { messageId: ids[0], status: "queued" }]
    },
    async sendBatch(items, options) {
      const [error, ids] = await queueProviderResult("postgres", "send-batch", () => enqueue(items.map(item => ({
        delaySeconds: item.delaySeconds ?? options?.delaySeconds,
        id: createQueueMessageId(),
        idempotencyKey: item.idempotencyKey,
        payload: item.body,
      }))))
      if (error) return [error, undefined]
      return [undefined, ids.map(messageId => ({ messageId, status: "queued" as const }))]
    },
  }
}
