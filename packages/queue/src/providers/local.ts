import { randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"

import { join, resolve } from "pathe"

import { createQueueMessageId, normalizeQueueEnqueueInput } from "../enqueue.ts"
import { formatQueueOptionNames, queueProviderResult } from "../errors.ts"
import { queueErrorDiagnostics } from "../error-diagnostics.ts"
import { createQueueDeliveryErrorReport, isNonRetryableQueueError, reportQueueDeliveryError } from "../internal/delivery-error.ts"
import { checkQueueHandlerResponse } from "../internal/handler-response.ts"

import type { LocalQueueClient, QueueDefinition, QueueEnqueueOptions } from "../types.ts"

/** Cloudflare's default: one delivery and three retries. */
export const localQueueMaxAttempts = 4

/** Dead jobs that the local provider keeps per Queue Definition. It deletes the oldest above this count. */
export const localQueueDeadLimit = 100

export const localUnsupportedEnqueueOptions = ["contentType", "region", "retentionSeconds"] as const

type DeliveryError = ReturnType<typeof createQueueDeliveryErrorReport>["error"]

/** One accepted job, as it is stored in `<base>/<key>.json`. */
interface StoredJob {
  attempts: number
  /** Epoch milliseconds of the next delivery. */
  availableAt: number
  enqueuedAt: number
  /** The last delivery error of a dead job. */
  error?: DeliveryError
  /** Epoch milliseconds when the job became dead. */
  failedAt?: number
  id: string
  idempotencyKey?: string
  /** File name. The message ID comes from the caller and is not safe as a file name. */
  key: string
  payload?: unknown
  queue: string
  /**
   * `dead` jobs used all attempts, or failed with an error that a retry cannot fix. They stay on disk for inspection,
   * up to `localQueueDeadLimit` per Queue Definition. `done` jobs ran, but their file could not be deleted.
   */
  state: "dead" | "done" | "pending"
}

export interface LocalQueueStatus {
  /** Absolute directory of the stored jobs. */
  base: string
  /** Dead jobs kept per Queue Definition. Older dead jobs are deleted. */
  deadLimit: number
  /** The jobs survive a restart of this host. Another host or a new container does not see them. */
  durability: "single-host"
  queues: Record<string, { dead: number, pending: number, running: number }>
}

export interface LocalQueueEntry {
  delaySeconds?: number
  id: string
  idempotencyKey?: string
  payload: unknown
}

export interface LocalQueueEngine {
  readonly base: string
  close: () => void
  /**
   * Stores the jobs and returns their message IDs. A pending or running job with the same `idempotencyKey` returns
   * its ID instead. When one file of the batch cannot be written, no job of the batch is stored.
   */
  enqueue: (queue: string, entries: readonly LocalQueueEntry[]) => Promise<string[]>
  /** Reads the stored jobs and starts their delivery. Later calls return the same promise. */
  start: () => Promise<void>
  status: () => Promise<LocalQueueStatus>
}

export interface LocalQueueEngineOptions {
  base: string
  load: (queue: string) => Promise<QueueDefinition | undefined>
  missing: (queue: string) => Error
  /** Milliseconds before the next delivery after `attempts` failed deliveries. Defaults to 1s, 2s, 4s, up to 60s. */
  retryDelayMs?: (attempts: number) => number
}

// setTimeout fires at once for a delay above 2^31 - 1 milliseconds.
const maxTimerDelay = 2 ** 31 - 1

function defaultRetryDelayMs(attempts: number): number {
  return Math.min(2 ** (attempts - 1), 60) * 1000
}

function isStoredJob(value: unknown): value is StoredJob {
  if (!value || typeof value !== "object") return false
  const job = value as Record<string, unknown>
  return typeof job.key === "string" && typeof job.id === "string" && typeof job.queue === "string"
    && typeof job.attempts === "number" && typeof job.availableAt === "number" && typeof job.enqueuedAt === "number"
    && (job.state === "pending" || job.state === "dead" || job.state === "done")
}

function toStoredPayload(payload: unknown): { payload?: unknown } {
  // The job crosses a restart, so the handler gets the JSON copy, as it does from a hosted provider.
  const text = JSON.stringify(payload)
  return text === undefined ? {} : { payload: JSON.parse(text) }
}

function delayMs(delaySeconds: number | undefined): number {
  if (delaySeconds === undefined) return 0
  if (!Number.isFinite(delaySeconds) || delaySeconds < 0) {
    throw new RangeError(`\`delaySeconds\` must be a number of seconds from 0, got ${String(delaySeconds)}.`)
  }
  return delaySeconds * 1000
}

export function createLocalQueueEngine(options: LocalQueueEngineOptions): LocalQueueEngine {
  const base = resolve(options.base)
  const retryDelayMs = options.retryDelayMs ?? defaultRetryDelayMs
  const jobs = new Map<string, StoredJob>()
  const running = new Map<string, number>()
  const runningKeys = new Set<string>()
  // Accepted jobs whose files are not written yet. They hold their idempotency key, but they do not run.
  const writingKeys = new Set<string>()
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
      if (job.state !== "pending" || runningKeys.has(job.key) || writingKeys.has(job.key)) continue
      if (job.availableAt > now) {
        next = Math.min(next, job.availableAt)
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

  async function markDead(job: StoredJob, error: DeliveryError) {
    job.state = "dead"
    job.error = error
    job.failedAt = Date.now()
    console.error(`[vitehub:queue] The local provider stopped delivery of a "${job.queue}" job after ${job.attempts} attempts. The job stays in ${file(job)}.`)
    await persist(job)
    // The file keeps the payload for inspection. Memory keeps only the counts.
    delete job.payload
    await pruneDead(job.queue)
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
      if (job.attempts >= localQueueMaxAttempts) {
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
        const context = { attempts: job.attempts, id: job.id, provider: "local", queue: job.queue } as const
        reportQueueDeliveryError(error, context)
        if (isNonRetryableQueueError(error) || job.attempts >= localQueueMaxAttempts) {
          await markDead(job, createQueueDeliveryErrorReport(error, context).error)
        }
        else {
          job.availableAt = Date.now() + retryDelayMs(job.attempts)
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

  return {
    base,
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
        for (const entry of entries) {
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
            availableAt: now + delayMs(entry.delaySeconds),
            enqueuedAt: now,
            id: entry.id,
            ...(entry.idempotencyKey === undefined ? {} : { idempotencyKey: entry.idempotencyKey }),
            key: randomUUID(),
            ...toStoredPayload(entry.payload),
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

function unsupportedOptions(options: QueueEnqueueOptions) {
  const unsupported = localUnsupportedEnqueueOptions.filter(option => options[option] !== undefined)
  return unsupported.length
    ? queueErrorDiagnostics.QUEUE_UNSUPPORTED_OPTION({ options: formatQueueOptionNames(unsupported), provider: "local" })
    : undefined
}

export function createLocalQueueClient(engine: LocalQueueEngine, queue: string): LocalQueueClient {
  return {
    provider: "local",
    native: engine,
    queue,
    async send(payload, options) {
      const normalized = normalizeQueueEnqueueInput(payload, options)
      const optionsError = unsupportedOptions(normalized.options)
      if (optionsError) return [optionsError, undefined]
      const [error, ids] = await queueProviderResult("local", "send", () => engine.enqueue(queue, [{
        delaySeconds: normalized.options.delaySeconds,
        id: normalized.id,
        idempotencyKey: normalized.options.idempotencyKey,
        payload: normalized.payload,
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
      }))))
      if (error) return [error, undefined]
      return [undefined, ids.map(messageId => ({ messageId, status: "queued" as const }))]
    },
  }
}
