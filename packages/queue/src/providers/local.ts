import { randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"

import { join, resolve } from "pathe"
import { runInRunScopes } from "@vite-hub/runtime/internal/run-scope"

import { readQueueTimes } from "../duration.ts"
import { createQueueMessageId, normalizeQueueEnqueueInput } from "../enqueue.ts"
import { cloudflareUnsupportedEnqueueOptions, localUnsupportedEnqueueOptions, postgresUnsupportedEnqueueOptions, queueProviderResult, queueRemovedOptionsError, queueUnsupportedOptionsError } from "../errors.ts"
import { createQueueDeliveryErrorReport, isNonRetryableQueueError, reportQueueDeliveryError } from "../internal/delivery-error.ts"
import { checkQueueHandlerResponse } from "../internal/handler-response.ts"
import { queueErrorDiagnostics } from "../error-diagnostics.ts"

import type { Duration } from "@vite-hub/runtime"
import type { LocalQueueClient, LocalQueueDeliveryRules, LocalQueueJob, LocalQueueRules, LocalQueueStatus, QueueDefinition, QueueDeliveryErrorDetails, QueueEnqueueOptions, QueueJobStore } from "../types.ts"

export type { LocalQueueClearFilter, LocalQueueDeliveryRules, LocalQueueJob, LocalQueueJobDetail, LocalQueueStatus, QueueJobsFilter, QueueJobStore } from "../types.ts"

/** Cloudflare's default: one delivery and three retries. */
export const localQueueMaxAttempts = 4

/** Dead jobs that the local provider keeps per Queue Definition. It deletes the oldest above this count. */
export const localQueueDeadLimit = 100

type DeliveryError = QueueDeliveryErrorDetails

interface StoredJob {
  attempts: number
  availableAt: number
  enqueuedAt: number
  error?: DeliveryError
  expiresAt?: number
  failedAt?: number
  id: string
  idempotencyKey?: string
  key: string
  payload?: unknown
  queue: string
  retentionMs?: number
  state: "dead" | "done" | "pending"
}

/** One job for the engine. `vite dev` and the clients read `delay` and `retention` into seconds first. */
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

const maxTimerDelay = 2 ** 31 - 1
const storeRetryMaxMs = 30_000

function storeRetryDelayMs(failures: number): number {
  return Math.min(10 * 2 ** (failures - 1), storeRetryMaxMs)
}

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
  cloudflare: {
    maxAttempts: localQueueMaxAttempts,
    maxBatchBytes: 256 * 1024,
    maxBatchJobs: 100,
    maxDelaySeconds: day,
    maxPayloadBytes: 128 * 1024 - 100,
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
  postgres: {
    maxAttempts: localQueueMaxAttempts,
    retryDelayMs: defaultRetryDelayMs,
    rules: "postgres",
    unsupportedOptions: postgresUnsupportedEnqueueOptions,
  },
  vercel: {
    maxAttempts: Number.POSITIVE_INFINITY,
    maxBatchJobs: 100,
    maxDelaySeconds: 7 * day,
    maxPayloadBytes: 100 * 1024 * 1024,
    retention: { defaultSeconds: day, maxSeconds: 7 * day, minSeconds: 60 },
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

function toStoredPayload(payload: unknown): { bytes: number, stored: { payload?: unknown } } {
  const text = JSON.stringify(payload)
  return text === undefined ? { bytes: 0, stored: {} } : { bytes: Buffer.byteLength(text), stored: { payload: JSON.parse(text) } }
}

export function delayMs(delaySeconds: number | undefined, rules: LocalQueueDeliveryRules): number {
  if (delaySeconds === undefined) return 0
  if (!Number.isFinite(delaySeconds) || delaySeconds < 0) {
    throw queueErrorDiagnostics.QUEUE_LOCAL_LIMIT_EXCEEDED({ limit: "delay", provider: providerNames[rules.rules], value: String(delaySeconds) })
  }
  if (rules.maxDelaySeconds !== undefined && delaySeconds > rules.maxDelaySeconds) {
    throw queueErrorDiagnostics.QUEUE_LOCAL_LIMIT_EXCEEDED({ limit: "delay-max", max: rules.maxDelaySeconds, provider: providerNames[rules.rules], value: delaySeconds })
  }
  return delaySeconds * 1000
}

function retentionMs(retentionSeconds: number | undefined, rules: LocalQueueDeliveryRules): number | undefined {
  const retention = rules.retention
  if (!retention) return undefined
  const seconds = retentionSeconds ?? retention.defaultSeconds
  if (!Number.isFinite(seconds) || seconds < retention.minSeconds || seconds > retention.maxSeconds) {
    throw queueErrorDiagnostics.QUEUE_LOCAL_LIMIT_EXCEEDED({ limit: "retention", max: retention.maxSeconds, min: retention.minSeconds, provider: providerNames[rules.rules], value: String(seconds) })
  }
  return seconds * 1000
}

function checkPayloadSize(bytes: number, rules: LocalQueueDeliveryRules) {
  if (rules.maxPayloadBytes !== undefined && bytes > rules.maxPayloadBytes) {
    throw queueErrorDiagnostics.QUEUE_LOCAL_LIMIT_EXCEEDED({ limit: "payload", max: rules.maxPayloadBytes, provider: providerNames[rules.rules], value: bytes })
  }
}

function checkBatch(entries: readonly LocalQueueEntry[], bytes: number, rules: LocalQueueDeliveryRules) {
  if (rules.rules === "vercel" && entries.length === 0) {
    throw queueErrorDiagnostics.QUEUE_LOCAL_LIMIT_EXCEEDED({ limit: "batch-empty", provider: providerNames[rules.rules], value: 0 })
  }
  if (entries.length < 2) return
  if (rules.maxBatchJobs !== undefined && entries.length > rules.maxBatchJobs) {
    throw queueErrorDiagnostics.QUEUE_LOCAL_LIMIT_EXCEEDED({ limit: "batch-jobs", max: rules.maxBatchJobs, provider: providerNames[rules.rules], value: entries.length })
  }
  if (rules.maxBatchBytes !== undefined && bytes > rules.maxBatchBytes) {
    throw queueErrorDiagnostics.QUEUE_LOCAL_LIMIT_EXCEEDED({ limit: "batch-bytes", max: rules.maxBatchBytes, provider: providerNames[rules.rules], value: bytes })
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
    state: running ? "running" : job.state === "dead" ? "dead" : "pending",
  }
}

export function createLocalQueueEngine(options: LocalQueueEngineOptions): LocalQueueEngine {
  const base = resolve(options.base)
  const rules = options.rules ?? localQueueDeliveryRules.local
  const retryDelayMs = options.retryDelayMs ?? rules.retryDelayMs
  const jobs = new Map<string, StoredJob>()
  const running = new Map<string, number>()
  const runningKeys = new Set<string>()
  const writingKeys = new Set<string>()
  const expiringKeys = new Set<string>()
  const concurrency = new Map<string, number>()
  const storeFailures = new WeakMap<StoredJob, number>()
  let enqueueTail = Promise.resolve()
  let started: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false

  const file = (job: Pick<StoredJob, "key">) => join(base, `${job.key}.json`)
  const attemptInFlight = (job: Pick<StoredJob, "key">) => runningKeys.has(job.key) || expiringKeys.has(job.key)

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
      if ((running.get(job.queue) ?? 0) < (concurrency.get(job.queue) ?? 1)) void deliver(job)
    }
    arm(next)
  }

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
    storeFailures.delete(job)
    job.state = "dead"
    job.error = error
    job.failedAt = Date.now()
    console.error(`[vitehub:queue] The local provider stopped delivery of a "${job.queue}" job ${reason}. The job stays in ${file(job)}.`)
    await persist(job)
    delete job.payload
    await pruneDead(job.queue)
  }

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
    job.state = "done"
    try {
      await unlink(job)
      jobs.delete(job.key)
    }
    catch (error) {
      console.error(`[vitehub:queue] The local provider ran a job, but cannot delete ${file(job)}.`, error)
      await persist(job).catch((persistError: unknown) => console.error(`[vitehub:queue] The local provider cannot mark ${file(job)} done either. The job runs again after a restart.`, persistError))
    }
  }

  async function deliver(job: StoredJob) {
    runningKeys.add(job.key)
    running.set(job.queue, (running.get(job.queue) ?? 0) + 1)
    try {
      if (job.attempts >= rules.maxAttempts) {
        await markDead(job, { message: "[vitehub] The process stopped during the last attempt of this job.", name: "Error" })
        return
      }
      const attempts = job.attempts + 1
      await persist({ ...job, attempts })
      storeFailures.delete(job)
      job.attempts = attempts
      let handled = false
      try {
        const definition = await options.load(job.queue)
        if (!definition) throw options.missing(job.queue)
        const limit = Number(definition.concurrency ?? 1)
        concurrency.set(job.queue, Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1)
        schedule()
        await runInRunScopes(async () => {
          checkQueueHandlerResponse(await definition.handler({ attempts: job.attempts, id: job.id, payload: job.payload }))
        })
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
          job.error = createQueueDeliveryErrorReport(error, context).error
          await persist(job)
        }
      }
      if (handled) await complete(job)
    }
    catch (storeError) {
      if (job.state === "pending") {
        const failures = (storeFailures.get(job) ?? 0) + 1
        storeFailures.set(job, failures)
        job.availableAt = Date.now() + Math.max(retryDelayMs(Math.max(1, job.attempts)), storeRetryDelayMs(failures))
      }
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
    for (const job of recovered.sort((a, b) => a.enqueuedAt - b.enqueuedAt)) jobs.set(job.key, job)
    for (const queue of new Set(recovered.map(job => job.queue))) await pruneDead(queue)
    schedule()
  }

  function findJob(id: string): StoredJob | undefined {
    let found: StoredJob | undefined
    for (const job of jobs.values()) {
      if (job.id !== id || job.state === "done" || writingKeys.has(job.key)) continue
      if (!found || job.enqueuedAt >= found.enqueuedAt) found = job
    }
    return found
  }

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
      const enqueued = enqueueTail.then(async () => {
        const now = Date.now()
        const created: StoredJob[] = []
        const ids: string[] = []
        const prepared = entries.map((entry) => {
          const { bytes, stored } = toStoredPayload(entry.payload)
          checkPayloadSize(bytes, rules)
          const retention = retentionMs(entry.retentionSeconds, rules)
          return { availableAt: now + delayMs(entry.delaySeconds, rules), bytes, entry, ...(retention === undefined ? {} : { expiresAt: now + retention }), stored }
        })
        checkBatch(entries, prepared.reduce((total, item) => total + item.bytes, 0), rules)
        for (const { availableAt, entry, expiresAt, stored } of prepared) {
          const duplicate = entry.idempotencyKey === undefined
            ? undefined
            : [...jobs.values(), ...created].find(job => job.queue === queue && job.idempotencyKey === entry.idempotencyKey
              && (job.state === "pending" || (job.state === "dead" && attemptInFlight(job))))
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
        const written = await Promise.allSettled(created.map(persist))
        for (const job of created) writingKeys.delete(job.key)
        const failed = written.find(result => result.status === "rejected")
        if (failed) {
          for (const job of created) jobs.delete(job.key)
          await Promise.allSettled(created.map(unlink))
          throw failed.reason
        }
        schedule()
        return ids
      })
      enqueueTail = enqueued.then(() => undefined, () => undefined)
      return enqueued
    },
    async job(id) {
      await this.start()
      const job = findJob(id)
      if (!job) return undefined
      return {
        ...toJobSummary(job, attemptInFlight(job)),
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
        .map(job => toJobSummary(job, attemptInFlight(job)))
    },
    async retry(id) {
      await this.start()
      const job = findJob(id)
      if (!job) return "missing"
      if (attemptInFlight(job)) return "running"
      const now = Date.now()
      if (job.state === "dead") {
        const { payload } = await readPayload(job)
        const retry: StoredJob = { ...job, attempts: 0, ...(payload === undefined ? {} : { payload }), state: "pending" }
        delete retry.error
        delete retry.failedAt
        if (job.expiresAt !== undefined) {
          retry.retentionMs = job.retentionMs ?? (job.expiresAt - job.enqueuedAt)
          retry.expiresAt = now + retry.retentionMs
        }
        retry.availableAt = now
        await persist(retry)
        jobs.set(job.key, retry)
        schedule()
        return toJobSummary(retry, attemptInFlight(retry))
      }
      job.availableAt = now
      await persist(job)
      schedule()
      return toJobSummary(job, attemptInFlight(job))
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
        if (attemptInFlight(job)) entry.running++
        else if (job.state === "dead") entry.dead++
        else entry.pending++
      }
      return { base, deadLimit: localQueueDeadLimit, durability: "single-host", queues }
    },
  }
}

function unsupportedOptions(options: QueueEnqueueOptions, rules: LocalQueueDeliveryRules) {
  return queueUnsupportedOptionsError(options, rules.rules, rules.unsupportedOptions)
}

export function createLocalQueueClient(engine: LocalQueueEngine, queue: string): LocalQueueClient {
  const round = engine.rules.rules === "vercel" || engine.rules.rules === "cloudflare" ? "ceil" : undefined
  return {
    provider: "local",
    native: engine,
    queue,
    async send(payload, options) {
      const normalized = normalizeQueueEnqueueInput(payload, options)
      const optionsError = unsupportedOptions(normalized.options, engine.rules)
      if (optionsError) return [optionsError, undefined]
      const [timeError, times] = readQueueTimes(normalized.options, round)
      if (timeError) return [timeError, undefined]
      const [error, ids] = await queueProviderResult("local", "send", () => engine.enqueue(queue, [{
        ...times,
        id: normalized.id,
        idempotencyKey: normalized.options.idempotencyKey,
        payload: normalized.payload,
      }]))
      if (error) return [error, undefined]
      return [undefined, { messageId: ids[0], status: "queued" }]
    },
    async sendBatch(items, options) {
      const removed = queueRemovedOptionsError(engine.rules.rules, options, items)
      if (removed) return [removed, undefined]
      const entries: LocalQueueEntry[] = []
      for (const item of items) {
        const retention = ("retention" in item ? item.retention : undefined) ?? (options && "retention" in options ? options.retention : undefined)
        // SAFETY: readQueueTimes() checks the value at runtime, and returns RUNTIME_DURATION_INVALID for a wrong one.
        const [timeError, times] = readQueueTimes({ delay: item.delay ?? options?.delay, retention: retention as Duration | number | undefined }, round)
        if (timeError) return [timeError, undefined]
        entries.push({ ...times, id: createQueueMessageId(), idempotencyKey: item.idempotencyKey, payload: item.body })
      }
      const [error, ids] = await queueProviderResult("local", "send-batch", () => engine.enqueue(queue, entries))
      if (error) return [error, undefined]
      return [undefined, ids.map(messageId => ({ messageId, status: "queued" as const }))]
    },
  }
}
