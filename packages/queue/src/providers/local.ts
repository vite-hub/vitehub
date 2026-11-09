import { randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"

import { join, resolve } from "pathe"

import { createQueueMessageId, normalizeQueueEnqueueInput } from "../enqueue.ts"
import { cloudflareUnsupportedEnqueueOptions, localUnsupportedEnqueueOptions, postgresUnsupportedEnqueueOptions, queueProviderResult, queueUnsupportedOptionsError } from "../errors.ts"
import { createQueueDeliveryErrorReport, isNonRetryableQueueError, reportQueueDeliveryError } from "../internal/delivery-error.ts"
import { checkQueueHandlerResponse } from "../internal/handler-response.ts"

import type { LocalQueueClient, LocalQueueDeliveryRules, LocalQueueJob, LocalQueueRules, LocalQueueStatus, QueueDefinition, QueueDeliveryErrorDetails, QueueEnqueueOptions, QueueJobStore } from "../types.ts"

export type { LocalQueueClearFilter, LocalQueueDeliveryRules, LocalQueueJob, LocalQueueJobDetail, LocalQueueStatus, QueueJobsFilter, QueueJobStore } from "../types.ts"

/** Cloudflare's default: one delivery and three retries. */
export const localQueueMaxAttempts = 4

/** Dead jobs that the local provider keeps per Queue Definition. It deletes the oldest above this count. */
export const localQueueDeadLimit = 100

type DeliveryError = QueueDeliveryErrorDetails

/** One accepted job, as it is stored in `<base>/<key>.json`. */
interface StoredJob {
  attempts: number
  /** Epoch milliseconds of the next delivery. */
  availableAt: number
  enqueuedAt: number
  /** The last delivery error. A pending job has one after a failed attempt. */
  error?: DeliveryError
  /** Epoch milliseconds when the job expires, for rules with a retention. */
  expiresAt?: number
  /** Epoch milliseconds when the job became dead. */
  failedAt?: number
  id: string
  idempotencyKey?: string
  /** File name. The message ID comes from the caller and is not safe as a file name. */
  key: string
  payload?: unknown
  queue: string
  /** Original retention duration, captured before the first manual retry refreshes `expiresAt`. */
  retentionMs?: number
  /**
   * `dead` jobs used all attempts, or failed with an error that a retry cannot fix. They stay on disk for inspection,
   * up to `localQueueDeadLimit` per Queue Definition. `done` jobs ran, but their file could not be deleted.
   */
  state: "dead" | "done" | "pending"
}

export interface LocalQueueEntry {
  delaySeconds?: number
  id: string
  idempotencyKey?: string
  payload: unknown
  retentionSeconds?: number
}

export interface LocalQueueEngine extends QueueJobStore {
  readonly provider: "local"
  close: () => void
  /**
   * Stores the jobs and returns their message IDs. A pending or running job with the same `idempotencyKey` returns
   * its ID instead. When one file of the batch cannot be written, no job of the batch is stored.
   */
  enqueue: (queue: string, entries: readonly LocalQueueEntry[]) => Promise<string[]>
  /** Reads the stored jobs and starts their delivery. Later calls return the same promise. */
  start: () => Promise<void>
}

export interface LocalQueueEngineOptions {
  base: string
  /** `vite dev` sets this. A stored job error then keeps the message and stack of a plain `Error`. */
  development?: boolean
  load: (queue: string) => Promise<QueueDefinition | undefined>
  missing: (queue: string) => Error
  /** Milliseconds before the next delivery after `attempts` failed deliveries. Defaults to the delay of `rules`. */
  retryDelayMs?: (attempts: number) => number
  /** Delivery rules. Defaults to the local rules: 4 attempts with retries after 1, 2, and 4 seconds. */
  rules?: LocalQueueDeliveryRules
}

// setTimeout fires at once for a delay above 2^31 - 1 milliseconds.
const maxTimerDelay = 2 ** 31 - 1

/** Retries after 1, 2, and 4 seconds, up to 60 seconds. The local and postgres providers use it. */
export function defaultRetryDelayMs(attempts: number): number {
  return Math.min(2 ** (attempts - 1), 60) * 1000
}

const day = 24 * 60 * 60

/**
 * Delivery rules per provider. `vite dev` runs the jobs of a Cloudflare or Vercel app with the local engine and the
 * documented defaults of that provider, so a handler fails, retries, and stops in dev as it does on the host.
 */
export const localQueueDeliveryRules: Readonly<Record<LocalQueueRules, LocalQueueDeliveryRules>> = {
  // https://developers.cloudflare.com/queues/configuration/batching-retries/ and /queues/platform/limits/
  cloudflare: {
    // `max_retries` defaults to 3, and ViteHub does not set it.
    maxAttempts: localQueueMaxAttempts,
    maxBatchBytes: 256 * 1024,
    maxBatchJobs: 100,
    maxDelaySeconds: day,
    // 128 KB, and Cloudflare counts about 100 bytes of metadata.
    maxPayloadBytes: 128 * 1024 - 100,
    // Without `retry_delay`, Cloudflare delivers a retried message again at once.
    retryDelayMs: () => 0,
    rules: "cloudflare",
    unsupportedOptions: cloudflareUnsupportedEnqueueOptions,
  },
  local: {
    maxAttempts: localQueueMaxAttempts,
    retryDelayMs: defaultRetryDelayMs,
    rules: "local",
    unsupportedOptions: localUnsupportedEnqueueOptions,
  },
  // The postgres provider has the local rules. `vite dev` runs the jobs of a postgres app with the local engine.
  postgres: {
    maxAttempts: localQueueMaxAttempts,
    retryDelayMs: defaultRetryDelayMs,
    rules: "postgres",
    unsupportedOptions: postgresUnsupportedEnqueueOptions,
  },
  // https://vercel.com/docs/queues/concepts and https://vercel.com/docs/queues/pricing#limits
  vercel: {
    // The generated queue trigger sets no `maxDeliveries`, so Vercel retries until the job expires.
    maxAttempts: Number.POSITIVE_INFINITY,
    maxBatchJobs: 100,
    maxDelaySeconds: 7 * day,
    maxPayloadBytes: 100 * 1024 * 1024,
    retention: { defaultSeconds: day, maxSeconds: 7 * day, minSeconds: 60 },
    // `retryAfterSeconds` of the queue trigger defaults to 60 seconds.
    retryDelayMs: () => 60_000,
    rules: "vercel",
    unsupportedOptions: ["contentType"],
  },
}

function isStoredJob(value: unknown): value is StoredJob {
  if (!value || typeof value !== "object") return false
  const job = value as Record<string, unknown>
  return typeof job.key === "string" && typeof job.id === "string" && typeof job.queue === "string"
    && typeof job.attempts === "number" && typeof job.availableAt === "number" && typeof job.enqueuedAt === "number"
    && (job.state === "pending" || job.state === "dead" || job.state === "done")
}

const providerNames: Readonly<Record<LocalQueueRules, string>> = { cloudflare: "Cloudflare", local: "The local provider", postgres: "The postgres provider", vercel: "Vercel" }

/** The JSON copy of the payload and its size in bytes. */
function toStoredPayload(payload: unknown): { bytes: number, stored: { payload?: unknown } } {
  // The job crosses a restart, so the handler gets the JSON copy, as it does from a hosted provider.
  const text = JSON.stringify(payload)
  return text === undefined ? { bytes: 0, stored: {} } : { bytes: Buffer.byteLength(text), stored: { payload: JSON.parse(text) } }
}

export function delayMs(delaySeconds: number | undefined, rules: LocalQueueDeliveryRules): number {
  if (delaySeconds === undefined) return 0
  if (!Number.isFinite(delaySeconds) || delaySeconds < 0) {
    throw new RangeError(`\`delaySeconds\` must be a number of seconds from 0, got ${String(delaySeconds)}.`)
  }
  if (rules.maxDelaySeconds !== undefined && delaySeconds > rules.maxDelaySeconds) {
    throw new RangeError(`${providerNames[rules.rules]} accepts \`delaySeconds\` up to ${rules.maxDelaySeconds}, got ${delaySeconds}.`)
  }
  return delaySeconds * 1000
}

function retentionMs(retentionSeconds: number | undefined, rules: LocalQueueDeliveryRules): number | undefined {
  const retention = rules.retention
  if (!retention) return undefined
  const seconds = retentionSeconds ?? retention.defaultSeconds
  if (!Number.isFinite(seconds) || seconds < retention.minSeconds || seconds > retention.maxSeconds) {
    throw new RangeError(`${providerNames[rules.rules]} accepts \`retentionSeconds\` from ${retention.minSeconds} to ${retention.maxSeconds}, got ${String(seconds)}.`)
  }
  return seconds * 1000
}

function checkPayloadSize(bytes: number, rules: LocalQueueDeliveryRules) {
  if (rules.maxPayloadBytes !== undefined && bytes > rules.maxPayloadBytes) {
    throw new RangeError(`${providerNames[rules.rules]} accepts a payload of up to ${rules.maxPayloadBytes} bytes, got ${bytes} bytes of JSON.`)
  }
}

function checkBatch(entries: readonly LocalQueueEntry[], bytes: number, rules: LocalQueueDeliveryRules) {
  if (rules.rules === "vercel" && entries.length === 0) {
    throw new RangeError("Vercel requires at least one job in a `sendBatch()`.")
  }
  if (entries.length < 2) return
  if (rules.maxBatchJobs !== undefined && entries.length > rules.maxBatchJobs) {
    throw new RangeError(`${providerNames[rules.rules]} accepts up to ${rules.maxBatchJobs} jobs in one \`sendBatch()\`, got ${entries.length}.`)
  }
  if (rules.maxBatchBytes !== undefined && bytes > rules.maxBatchBytes) {
    throw new RangeError(`${providerNames[rules.rules]} accepts up to ${rules.maxBatchBytes} bytes in one \`sendBatch()\`, got ${bytes} bytes of JSON.`)
  }
}

const isoTime = (time: number) => new Date(time).toISOString()

function toJobSummary(job: StoredJob, running: boolean): LocalQueueJob {
  return {
    attempts: job.attempts,
    availableAt: isoTime(job.availableAt),
    enqueuedAt: isoTime(job.enqueuedAt),
    ...(job.error ? { error: job.error } : {}),
    ...(job.expiresAt === undefined ? {} : { expiresAt: isoTime(job.expiresAt) }),
    ...(job.failedAt === undefined ? {} : { failedAt: isoTime(job.failedAt) }),
    id: job.id,
    queue: job.queue,
    state: job.state === "dead" ? "dead" : running ? "running" : "pending",
  }
}

export function createLocalQueueEngine(options: LocalQueueEngineOptions): LocalQueueEngine {
  const base = resolve(options.base)
  const rules = options.rules ?? localQueueDeliveryRules.local
  const retryDelayMs = options.retryDelayMs ?? rules.retryDelayMs
  const jobs = new Map<string, StoredJob>()
  const running = new Map<string, number>()
  const runningKeys = new Set<string>()
  // Accepted jobs whose files are not written yet. They hold their idempotency key, but they do not run.
  const writingKeys = new Set<string>()
  // Expired jobs whose dead state is not saved yet.
  const expiringKeys = new Set<string>()
  const concurrency = new Map<string, number>()
  let enqueueTail = Promise.resolve()
  let started: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false

  const file = (job: Pick<StoredJob, "key">) => join(base, `${job.key}.json`)

  async function persist(job: StoredJob) {
    const target = file(job)
    await writeFile(`${target}.tmp`, JSON.stringify(job), "utf8")
    await rename(`${target}.tmp`, target)
  }

  async function unlink(job: Pick<StoredJob, "key">) {
    await rm(`${file(job)}.tmp`, { force: true })
    await rm(file(job), { force: true })
  }

  function arm(at: number) {
    if (timer) clearTimeout(timer)
    timer = undefined
    if (closed || at === Number.POSITIVE_INFINITY) return
    timer = setTimeout(schedule, Math.min(Math.max(0, at - Date.now()), maxTimerDelay))
    // A due job does not keep a finished script alive. A server keeps the process alive.
    timer.unref?.()
  }

  function schedule() {
    if (closed) return
    const now = Date.now()
    let next = Number.POSITIVE_INFINITY
    for (const job of jobs.values()) {
      if (job.state !== "pending" || runningKeys.has(job.key) || writingKeys.has(job.key) || expiringKeys.has(job.key)) continue
      if (job.expiresAt !== undefined && job.expiresAt <= now) {
        void expire(job)
        continue
      }
      if (job.availableAt > now) {
        next = Math.min(next, job.availableAt, job.expiresAt ?? Number.POSITIVE_INFINITY)
        continue
      }
      // A full queue starts its next job when a running job ends.
      if ((running.get(job.queue) ?? 0) < (concurrency.get(job.queue) ?? 1)) void deliver(job)
    }
    arm(next)
  }

  /** Deletes the oldest dead jobs of `queue` above `localQueueDeadLimit`. */
  async function pruneDead(queue: string) {
    const dead = [...jobs.values()].filter(job => job.queue === queue && job.state === "dead")
      .sort((a, b) => (a.failedAt ?? 0) - (b.failedAt ?? 0))
    for (const job of dead.slice(0, Math.max(0, dead.length - localQueueDeadLimit))) {
      jobs.delete(job.key)
      await unlink(job).catch((error: unknown) => {
        console.error(`[vitehub:queue] The local provider cannot delete the dead job file ${file(job)}.`, error)
      })
    }
  }

  async function markDead(job: StoredJob, error: DeliveryError, reason = `after ${job.attempts} attempts`) {
    job.state = "dead"
    job.error = error
    job.failedAt = Date.now()
    console.error(`[vitehub:queue] The local provider stopped delivery of a "${job.queue}" job ${reason}. The job stays in ${file(job)}.`)
    await persist(job)
    // The file keeps the payload for inspection. Memory keeps only the counts.
    delete job.payload
    await pruneDead(job.queue)
  }

  /** A job with a retention is not delivered after it expires, as on Vercel. */
  async function expire(job: StoredJob) {
    expiringKeys.add(job.key)
    try {
      await markDead(job, { message: "[vitehub] The job expired at the end of its retention period.", name: "Error" }, "because its retention period ended")
    }
    catch (error) {
      console.error(`[vitehub:queue] The local provider cannot update the job file in ${base}.`, error)
    }
    finally {
      expiringKeys.delete(job.key)
    }
  }

  async function complete(job: StoredJob) {
    // A job stays in the map until its file is gone, so a failed delete does not run it again in this process.
    job.state = "done"
    try {
      await unlink(job)
      jobs.delete(job.key)
    }
    catch (error) {
      console.error(`[vitehub:queue] The local provider ran a job, but cannot delete ${file(job)}.`, error)
      // A `done` file is deleted on the next start and does not run again.
      await persist(job).catch(() => {})
    }
  }

  async function deliver(job: StoredJob) {
    runningKeys.add(job.key)
    running.set(job.queue, (running.get(job.queue) ?? 0) + 1)
    try {
      // The attempt count is saved before the handler runs. A job at the limit lost its last attempt to a stopped
      // process, for example a handler that crashes the process, so it does not run again.
      if (job.attempts >= rules.maxAttempts) {
        await markDead(job, { message: "[vitehub] The process stopped during the last attempt of this job.", name: "Error" })
        return
      }
      const attempts = job.attempts + 1
      await persist({ ...job, attempts })
      job.attempts = attempts
      let handled = false
      try {
        const definition = await options.load(job.queue)
        if (!definition) throw options.missing(job.queue)
        const limit = Number(definition.options?.concurrency ?? 1)
        concurrency.set(job.queue, Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1)
        // The first job of a queue reads its limit, so start the other due jobs now.
        schedule()
        checkQueueHandlerResponse(await definition.handler({ attempts: job.attempts, id: job.id, payload: job.payload }))
        handled = true
      }
      catch (error) {
        const context = { attempts: job.attempts, development: options.development, id: job.id, provider: "local", queue: job.queue } as const
        reportQueueDeliveryError(error, context)
        if (isNonRetryableQueueError(error) || job.attempts >= rules.maxAttempts) {
          await markDead(job, createQueueDeliveryErrorReport(error, context).error)
        }
        else {
          job.availableAt = Date.now() + retryDelayMs(job.attempts)
          // A pending job keeps its last error, so `vitehub queue jobs list` shows why it waits.
          job.error = createQueueDeliveryErrorReport(error, context).error
          await persist(job)
        }
      }
      if (handled) await complete(job)
    }
    catch (storeError) {
      // Wait before the next try, so a full or read-only disk does not start the job again at once.
      job.availableAt = Date.now() + retryDelayMs(Math.max(1, job.attempts))
      console.error(`[vitehub:queue] The local provider cannot update the job file in ${base}.`, storeError)
    }
    finally {
      runningKeys.delete(job.key)
      running.set(job.queue, (running.get(job.queue) ?? 1) - 1)
      schedule()
    }
  }

  async function recover() {
    await mkdir(base, { recursive: true })
    const recovered: StoredJob[] = []
    for (const name of await readdir(base)) {
      if (!name.endsWith(".json")) continue
      try {
        const job: unknown = JSON.parse(await readFile(join(base, name), "utf8"))
        if (!isStoredJob(job) || `${job.key}.json` !== name) {
          console.error(`[vitehub:queue] The local provider skips ${join(base, name)}: it is not a stored job.`)
          continue
        }
        if (job.state === "done") {
          await unlink(job).catch(() => {})
          continue
        }
        // A production server can reopen the directory used by `vite dev`.
        if (options.development !== true && job.error && !job.error.code) {
          job.error = { message: "[vitehub] Queue Delivery failed.", name: "Error" }
          await persist(job)
        }
        if (job.state === "dead") delete job.payload
        recovered.push(job)
      }
      catch (error) {
        console.error(`[vitehub:queue] The local provider skips ${join(base, name)}: it cannot read it.`, error)
      }
    }
    // Deliver in the order the jobs were accepted.
    for (const job of recovered.sort((a, b) => a.enqueuedAt - b.enqueuedAt)) jobs.set(job.key, job)
    for (const queue of new Set(recovered.map(job => job.queue))) await pruneDead(queue)
    schedule()
  }

  /** The newest job with this message ID. Message IDs from the caller can repeat. */
  function findJob(id: string): StoredJob | undefined {
    let found: StoredJob | undefined
    for (const job of jobs.values()) {
      if (job.id !== id || job.state === "done" || writingKeys.has(job.key)) continue
      if (!found || job.enqueuedAt >= found.enqueuedAt) found = job
    }
    return found
  }

  /** Memory drops the payload of a dead job. Its file keeps it. */
  async function readPayload(job: StoredJob): Promise<{ payload?: unknown }> {
    if (job.state !== "dead") return Object.hasOwn(job, "payload") ? { payload: job.payload } : {}
    const stored: unknown = JSON.parse(await readFile(file(job), "utf8"))
    return isStoredJob(stored) && Object.hasOwn(stored, "payload") ? { payload: stored.payload } : {}
  }

  return {
    base,
    async clear(filter = {}) {
      await this.start()
      let cleared = 0
      for (const job of [...jobs.values()]) {
        if (job.state === "done" || runningKeys.has(job.key) || writingKeys.has(job.key) || expiringKeys.has(job.key)) continue
        if (filter.queue !== undefined && job.queue !== filter.queue) continue
        if (filter.state !== undefined && job.state !== filter.state) continue
        jobs.delete(job.key)
        await unlink(job)
        cleared++
      }
      return cleared
    },
    close() {
      closed = true
      arm(Number.POSITIVE_INFINITY)
    },
    async enqueue(queue, entries) {
      await this.start()
      // Wait through persistence and rollback before another send can reuse an idempotency key.
      const enqueued = enqueueTail.then(async () => {
        const now = Date.now()
        const created: StoredJob[] = []
        const ids: string[] = []
        // Check every job before one is stored, so a send that breaks a limit stores nothing.
        const prepared = entries.map((entry) => {
          const { bytes, stored } = toStoredPayload(entry.payload)
          checkPayloadSize(bytes, rules)
          const retention = retentionMs(entry.retentionSeconds, rules)
          return { availableAt: now + delayMs(entry.delaySeconds, rules), bytes, entry, ...(retention === undefined ? {} : { expiresAt: now + retention }), stored }
        })
        checkBatch(entries, prepared.reduce((total, item) => total + item.bytes, 0), rules)
        for (const { availableAt, entry, expiresAt, stored } of prepared) {
          // Only a job that can still run holds its key. Include jobs admitted earlier in this batch.
          const duplicate = entry.idempotencyKey === undefined
            ? undefined
            : [...jobs.values(), ...created].find(job => job.queue === queue && job.state === "pending" && job.idempotencyKey === entry.idempotencyKey)
          if (duplicate) {
            ids.push(duplicate.id)
            continue
          }
          const job: StoredJob = {
            attempts: 0,
            availableAt,
            enqueuedAt: now,
            ...(expiresAt === undefined ? {} : { expiresAt }),
            id: entry.id,
            ...(entry.idempotencyKey === undefined ? {} : { idempotencyKey: entry.idempotencyKey }),
            key: randomUUID(),
            ...stored,
            queue,
            state: "pending",
          }
          created.push(job)
          ids.push(job.id)
        }
        for (const job of created) {
          jobs.set(job.key, job)
          writingKeys.add(job.key)
        }
        // `send()` returns after the files exist, so an accepted job survives a crash right after it.
        const written = await Promise.allSettled(created.map(persist))
        for (const job of created) writingKeys.delete(job.key)
        const failed = written.find(result => result.status === "rejected")
        if (failed) {
          // The send fails as a whole. Remove every file of it, so a retry does not store the jobs two times.
          for (const job of created) jobs.delete(job.key)
          await Promise.allSettled(created.map(unlink))
          throw failed.reason
        }
        schedule()
        return ids
      })
      // A failed send releases admission too, so later calls can retry the key.
      enqueueTail = enqueued.then(() => undefined, () => undefined)
      return enqueued
    },
    async job(id) {
      await this.start()
      const job = findJob(id)
      if (!job) return undefined
      return {
        ...toJobSummary(job, runningKeys.has(job.key)),
        file: file(job),
        ...(job.idempotencyKey === undefined ? {} : { idempotencyKey: job.idempotencyKey }),
        ...await readPayload(job),
      }
    },
    async jobs() {
      await this.start()
      return [...jobs.values()]
        .filter(job => job.state !== "done" && !writingKeys.has(job.key))
        .sort((a, b) => b.enqueuedAt - a.enqueuedAt)
        .map(job => toJobSummary(job, runningKeys.has(job.key)))
    },
    async retry(id) {
      await this.start()
      const job = findJob(id)
      if (!job) return "missing"
      if (runningKeys.has(job.key) || expiringKeys.has(job.key)) return "running"
      const now = Date.now()
      if (job.state === "dead") {
        const { payload } = await readPayload(job)
        const retry: StoredJob = { ...job, attempts: 0, ...(payload === undefined ? {} : { payload }), state: "pending" }
        delete retry.error
        delete retry.failedAt
        // An expired job gets the retention it had when it was sent.
        if (job.expiresAt !== undefined) {
          retry.retentionMs = job.retentionMs ?? (job.expiresAt - job.enqueuedAt)
          retry.expiresAt = now + retry.retentionMs
        }
        retry.availableAt = now
        await persist(retry)
        jobs.set(job.key, retry)
        schedule()
        return toJobSummary(retry, runningKeys.has(retry.key))
      }
      job.availableAt = now
      await persist(job)
      schedule()
      return toJobSummary(job, runningKeys.has(job.key))
    },
    provider: "local",
    rules,
    start() {
      started ??= recover()
      return started
    },
    async status() {
      await this.start()
      const queues: LocalQueueStatus["queues"] = {}
      for (const job of jobs.values()) {
        if (job.state === "done") continue
        const entry = queues[job.queue] ??= { dead: 0, pending: 0, running: 0 }
        if (job.state === "dead") entry.dead++
        else if (runningKeys.has(job.key)) entry.running++
        else entry.pending++
      }
      return { base, deadLimit: localQueueDeadLimit, durability: "single-host", queues }
    },
  }
}

/** The provider of the rules rejects the option, so `vite dev` fails as the host does. */
function unsupportedOptions(options: QueueEnqueueOptions, rules: LocalQueueDeliveryRules) {
  return queueUnsupportedOptionsError(options, rules.rules, rules.unsupportedOptions)
}

export function createLocalQueueClient(engine: LocalQueueEngine, queue: string): LocalQueueClient {
  return {
    provider: "local",
    native: engine,
    queue,
    async send(payload, options) {
      const normalized = normalizeQueueEnqueueInput(payload, options)
      const optionsError = unsupportedOptions(normalized.options, engine.rules)
      if (optionsError) return [optionsError, undefined]
      const [error, ids] = await queueProviderResult("local", "send", () => engine.enqueue(queue, [{
        delaySeconds: normalized.options.delaySeconds,
        id: normalized.id,
        idempotencyKey: normalized.options.idempotencyKey,
        payload: normalized.payload,
        retentionSeconds: normalized.options.retentionSeconds,
      }]))
      if (error) return [error, undefined]
      return [undefined, { messageId: ids[0], status: "queued" }]
    },
    async sendBatch(items, options) {
      const [error, ids] = await queueProviderResult("local", "send-batch", () => engine.enqueue(queue, items.map(item => ({
        delaySeconds: item.delaySeconds ?? options?.delaySeconds,
        id: createQueueMessageId(),
        idempotencyKey: item.idempotencyKey,
        payload: item.body,
        // A Vercel app sends `retentionSeconds` in `vite dev`. The local rules have no retention and ignore it.
        retentionSeconds: "retentionSeconds" in item && typeof item.retentionSeconds === "number" ? item.retentionSeconds : options && "retentionSeconds" in options && typeof options.retentionSeconds === "number" ? options.retentionSeconds : undefined,
      }))))
      if (error) return [error, undefined]
      return [undefined, ids.map(messageId => ({ messageId, status: "queued" as const }))]
    },
  }
}
