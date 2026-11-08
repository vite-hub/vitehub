import { redactInspectionText } from "@vite-hub/internal/inspect"

import { isQueueError, normalizePublicQueueIdentifier } from "../errors.ts"
import { getQueueRuntimeConfig, listQueueDefinitionNames } from "../internal/runtime/state.ts"
import { dynamicQueue } from "./client.ts"

import type { LocalQueueEngine, LocalQueueJob, LocalQueueJobDetail, LocalQueueStatus } from "../providers/local.ts"

import type { LocalQueueRules, QueueEnqueueOptions, QueueProvider } from "../types.ts"

export interface QueueListResult {
  /** `undefined` when the runtime has not installed a Queue configuration. */
  provider?: QueueProvider
  /** The local provider only: the provider whose delivery rules the jobs follow. In `vite dev`, the provider of the build. */
  rules?: LocalQueueRules
  /**
   * The local provider only: where the jobs are and what survives. `single-host` jobs survive a restart on this host,
   * but not a move to another host or a new container.
   */
  storage?: { base: string, deadLimit: number, durability: LocalQueueStatus["durability"] }
  /** `dead`, `pending`, and `running` are job counts of the local provider. Hosted providers do not report a backlog. */
  queues: Array<{ dead?: number, name: string, pending?: number, running?: number }>
}

export interface QueueJobsListInput {
  queue?: string
  state?: LocalQueueJob["state"]
}

export interface QueueJobsListResult {
  /** Absolute directory of the stored jobs. */
  base: string
  /** Stored jobs, newest first. Completed jobs are deleted, so the list has pending, running, and dead jobs. */
  jobs: LocalQueueJob[]
  provider: "local"
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
  provider?: QueueProvider
  queue: string
  status: "queued"
}

export interface QueueSendOperationInput {
  delaySeconds?: number
  id?: string
  idempotencyKey?: string
  payload: unknown
  queue: string
}

/** A failure with the fields that every surface reports. */
class QueueOperationError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly fix?: string) {
    super(redactInspectionText(message))
  }
}

const statuses: Readonly<Record<string, number>> = {
  QUEUE_DEFINITION_NOT_FOUND: 404,
  QUEUE_DISABLED: 409,
  QUEUE_PROVIDER_FAILED: 502,
  QUEUE_PROVIDER_INVALID_RESPONSE: 502,
  QUEUE_UNSUPPORTED_OPTION: 400,
}

/** Gives a Queue catalog error the status that the Console RPC reports. */
function failure(error: unknown): unknown {
  if (!isQueueError(error)) return error
  return new QueueOperationError(error.message, statuses[error.code] ?? 500, error.code, error.fix)
}

export async function listQueues(): Promise<QueueListResult> {
  const config = getQueueRuntimeConfig()
  if (config === false) {
    throw new QueueOperationError("Queue is disabled in this runtime.", 409, "QUEUE_DISABLED", "Add `hubQueue()` to the Vite config and do not set `queue: false`.")
  }
  const names = listQueueDefinitionNames()
  if (config?.provider === "local") {
    const { getLocalQueueStatus } = await import("../internal/runtime/local-client.ts")
    const status = await getLocalQueueStatus(config)
    if (status) {
      const empty = { dead: 0, pending: 0, running: 0 }
      return {
        provider: "local",
        ...(config.rules && config.rules !== "local" ? { rules: config.rules } : {}),
        queues: names.map(name => ({ name, ...empty, ...status.queues[name] })),
        storage: { base: status.base, deadLimit: status.deadLimit, durability: status.durability },
      }
    }
  }
  return {
    ...(config ? { provider: config.provider } : {}),
    queues: names.map(name => ({ name })),
  }
}

export async function sendToQueue(input: QueueSendOperationInput): Promise<QueueSendOperationResult> {
  const queue = normalizePublicQueueIdentifier(input.queue)
  if (!queue) throw new QueueOperationError("The queue name is not a valid Queue Definition name.", 400, "QUEUE_INVALID_NAME", "Pass the name of a Queue Definition. `vitehub queue list` shows them.")
  const options: QueueEnqueueOptions = {
    ...(input.delaySeconds === undefined ? {} : { delaySeconds: input.delaySeconds }),
    ...(input.id === undefined ? {} : { id: input.id }),
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
  }
  let result
  try {
    result = await dynamicQueue.run(queue, input.payload, options)
  }
  catch (error) {
    throw failure(error)
  }
  const [error, sent] = result
  if (error) throw failure(error)
  const provider = getQueueRuntimeConfig()
  return {
    ...(sent?.messageId ? { messageId: sent.messageId } : {}),
    ...(provider ? { provider: provider.provider } : {}),
    queue,
    status: "queued",
  }
}

/** The engine of the stored jobs. Cloudflare and Vercel do not let a producer read their queue, so only local jobs list. */
async function localJobs(): Promise<LocalQueueEngine> {
  const config = getQueueRuntimeConfig()
  if (config === false) {
    throw new QueueOperationError("Queue is disabled in this runtime.", 409, "QUEUE_DISABLED", "Add `hubQueue()` to the Vite config and do not set `queue: false`.")
  }
  const engine = config ? (await import("../internal/runtime/local-client.ts")).useLocalQueueEngine(config) : undefined
  if (!engine) {
    throw new QueueOperationError(`The ${config?.provider ?? "configured"} queue provider does not let the app read its jobs. Only the local provider stores jobs that ViteHub can list.`, 409, "QUEUE_JOBS_UNAVAILABLE", "Run the app with `vite dev`, which runs every job in the dev server, or on a Node server with the local provider. Read hosted jobs in the Cloudflare or Vercel dashboard.")
  }
  return engine
}

function jobNotFound(): QueueOperationError {
  return new QueueOperationError("No stored job has this message ID. The local provider deletes a job when its handler succeeds.", 404, "QUEUE_JOB_NOT_FOUND", "Run `vitehub queue jobs list` for the IDs of the pending, running, and dead jobs.")
}

export async function listQueueJobs(input: QueueJobsListInput): Promise<QueueJobsListResult> {
  const engine = await localJobs()
  const jobs = (await engine.jobs()).filter(job => (input.queue === undefined || job.queue === input.queue) && (input.state === undefined || job.state === input.state))
  return { base: engine.base, jobs, provider: "local", rules: engine.rules.rules }
}

export async function showQueueJob(id: string): Promise<{ job: LocalQueueJobDetail }> {
  const job = await (await localJobs()).job(id)
  if (!job) throw jobNotFound()
  return { job }
}

export async function retryQueueJob(id: string): Promise<{ job: LocalQueueJob }> {
  const result = await (await localJobs()).retry(id)
  if (result === "missing") throw jobNotFound()
  if (result === "running") throw new QueueOperationError("The job is running now.", 409, "QUEUE_JOB_RUNNING", "Wait for the attempt to end, then run `vitehub queue jobs show` for its state.")
  return { job: result }
}

export async function clearQueueJobs(input: QueueJobsClearInput): Promise<{ cleared: number }> {
  return { cleared: await (await localJobs()).clear(input) }
}
