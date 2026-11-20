import { redactInspectionText } from "@vite-hub/internal/inspect"
import { runtimeErrorDiagnostics } from "@vite-hub/runtime"

import { queueErrorDiagnostics } from "../error-diagnostics.ts"
import { isQueueError, normalizePublicQueueIdentifier } from "../errors.ts"
import { getQueueRuntimeConfig, getQueueRuntimeJobStore, listQueueDefinitionNames } from "../internal/runtime/state.ts"
import { dynamicQueue } from "./client.ts"

import type { LocalQueueJob, LocalQueueJobDetail, LocalQueueStatus, QueueJobStore } from "../providers/local.ts"

import type { Duration } from "@vite-hub/runtime"
import type { LocalQueueRules, QueueEnqueueOptions, QueueDriver } from "../types.ts"

export interface QueueListResult {
  /** `undefined` when the runtime has not installed a Queue configuration. */
  provider?: QueueDriver
  /** The local provider only: the provider whose delivery rules the jobs follow. In `vite dev`, the provider of the build. */
  rules?: LocalQueueRules
  /**
   * The local and postgres providers only: where the jobs are and what survives. `single-host` jobs survive a restart
   * on this host, but not a move to another host or a new container. `shared` jobs are in Postgres, and every
   * instance of the app runs them.
   */
  storage?: { base: string, deadLimit: number, durability: LocalQueueStatus["durability"] }
  /** `dead`, `pending`, and `running` are job counts of the local and postgres providers. Hosted providers do not report a backlog. */
  queues: Array<{ dead?: number, name: string, pending?: number, running?: number }>
}

export interface QueueJobsListInput {
  queue?: string
  state?: LocalQueueJob["state"]
}

export interface QueueJobsListResult {
  /** Absolute directory of the local provider, or the Postgres table and database, without the password. */
  base: string
  /**
   * Stored jobs, newest first. Completed jobs are deleted, so the list has pending, running, and dead jobs. The
   * postgres provider lists at most 1,000 jobs.
   */
  jobs: LocalQueueJob[]
  provider: QueueJobStore["provider"]
  /** The provider whose delivery rules the jobs follow. */
  rules: LocalQueueRules
}

export interface QueueJobsClearInput {
  queue?: string
  state?: "dead" | "pending"
}

export type { LocalQueueJob, LocalQueueJobDetail }

export interface QueueSendOperationResult {
  messageId?: string
  provider?: QueueDriver
  queue: string
  status: "queued"
}

export interface QueueSendOperationInput {
  /** Time before delivery, such as `"1m"`. The send reads it, and a wrong one fails with `RUNTIME_DURATION_INVALID`. */
  delay?: string
  idempotencyKey?: string
  payload: unknown
  queue: string
}

const statuses: Readonly<Record<string, number>> = {
  QUEUE_DEFINITION_NAME_INVALID: 400,
  QUEUE_DEFINITION_NOT_FOUND: 404,
  QUEUE_DISABLED: 409,
  QUEUE_JOB_DUPLICATE: 409,
  QUEUE_JOBS_UNAVAILABLE: 409,
  QUEUE_JOB_NOT_FOUND: 404,
  QUEUE_JOB_RUNNING: 409,
  QUEUE_PROVIDER_FAILED: 502,
  QUEUE_PROVIDER_INVALID_RESPONSE: 502,
  QUEUE_UNSUPPORTED_OPTION: 400,
}

function failure(error: unknown): unknown {
  if (runtimeErrorDiagnostics.RUNTIME_DURATION_INVALID.is(error)) return Object.assign(error, { status: 400, statusMessage: redactInspectionText(error.message) })
  if (!isQueueError(error)) return error
  return Object.assign(error, { status: statuses[error.code] ?? 500, statusMessage: redactInspectionText(error.message) })
}

export async function listQueues(): Promise<QueueListResult> {
  const config = getQueueRuntimeConfig()
  if (config === false) throw failure(queueErrorDiagnostics.QUEUE_DISABLED())
  const names = listQueueDefinitionNames()
  if (config?.driver === "local" || config?.driver === "postgres") {
    const status = config.driver === "postgres"
      ? await (await getQueueRuntimeJobStore())?.status()
      : await (await import("../internal/runtime/local-client.ts")).getLocalQueueStatus(config)
    if (status) {
      const empty = { dead: 0, pending: 0, running: 0 }
      return {
        provider: config.driver,
        ...(config.driver === "local" && config.rules && config.rules !== "local" ? { rules: config.rules } : {}),
        queues: names.map(name => ({ name, ...empty, ...status.queues[name] })),
        storage: { base: status.base, deadLimit: status.deadLimit, durability: status.durability },
      }
    }
  }
  return {
    ...(config ? { provider: config.driver } : {}),
    queues: names.map(name => ({ name })),
  }
}

export async function sendToQueue(input: QueueSendOperationInput): Promise<QueueSendOperationResult> {
  const queue = normalizePublicQueueIdentifier(input.queue)
  if (!queue) throw failure(queueErrorDiagnostics.QUEUE_DEFINITION_NAME_INVALID())
  const options: QueueEnqueueOptions = {
    // SAFETY: CLI and Console input is text. The send reads it with parseDuration() and returns RUNTIME_DURATION_INVALID for a wrong one.
    ...(input.delay === undefined ? {} : { delay: input.delay as Duration }),
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
  }
  let result
  try {
    result = await dynamicQueue.send(queue, input.payload, options)
  }
  catch (error) {
    throw failure(error)
  }
  const [error, sent] = result
  if (error) throw failure(error)
  const config = getQueueRuntimeConfig()
  return {
    ...(sent?.messageId ? { messageId: sent.messageId } : {}),
    ...(config ? { provider: config.driver } : {}),
    queue,
    status: "queued",
  }
}

async function localJobs(): Promise<QueueJobStore> {
  const config = getQueueRuntimeConfig()
  if (config === false) throw failure(queueErrorDiagnostics.QUEUE_DISABLED())
  const store = config?.driver === "postgres"
    ? await getQueueRuntimeJobStore()
    : config ? (await import("../internal/runtime/local-client.ts")).useLocalQueueEngine(config) : undefined
  if (!store) {
    throw failure(queueErrorDiagnostics.QUEUE_JOBS_UNAVAILABLE({ driver: config?.driver ?? "configured" }))
  }
  return store
}

function jobNotFound(): unknown {
  return failure(queueErrorDiagnostics.QUEUE_JOB_NOT_FOUND())
}

export async function listQueueJobs(input: QueueJobsListInput): Promise<QueueJobsListResult> {
  const engine = await localJobs()
  const jobs = (await engine.jobs(input)).filter(job => (input.queue === undefined || job.queue === input.queue) && (input.state === undefined || job.state === input.state))
  return { base: engine.base, jobs, provider: engine.provider, rules: engine.rules.rules }
}

export async function showQueueJob(id: string): Promise<{ job: LocalQueueJobDetail }> {
  const job = await (await localJobs()).job(id)
  if (!job) throw jobNotFound()
  return { job }
}

export async function retryQueueJob(id: string): Promise<{ job: LocalQueueJob }> {
  const result = await (await localJobs()).retry(id)
  if (result === "missing") throw jobNotFound()
  if (result === "running") throw failure(queueErrorDiagnostics.QUEUE_JOB_RUNNING())
  if (result === "duplicate") throw failure(queueErrorDiagnostics.QUEUE_JOB_DUPLICATE())
  return { job: result }
}

export async function clearQueueJobs(input: QueueJobsClearInput): Promise<{ cleared: number }> {
  return { cleared: await (await localJobs()).clear(input) }
}
