import { defineOperation, table } from "@vite-hub/internal/operations"
import * as v from "valibot"

import type { AnyOperation, OperationDefinition } from "@vite-hub/internal/operations"
import type { LocalQueueJob, LocalQueueJobDetail, QueueJobsClearInput, QueueJobsListInput, QueueJobsListResult, QueueListResult, QueueSendOperationInput, QueueSendOperationResult } from "./runtime/operations.ts"

// The runtime module reaches the Queue configuration that the generated server installs. The operations load it when
// they run, so the CLI and `vitehub inspect` can list them without it.
const runtime = () => import("./runtime/operations.ts")

function defineQueueOperation<Input, Output>(definition: Omit<OperationDefinition<Input, Output>, "section" | "user">): OperationDefinition<Input, Output> {
  // The Queue runtime answers for the section. The operations never read the signed-in user.
  return defineOperation({ ...definition, section: "queues", user: false })
}

const list = defineQueueOperation<Record<string, never>, QueueListResult>({
  cli: { namespace: "queue" },
  description: "List the Queue Definitions of the app and the provider that sends their jobs. The local and postgres providers also report where they store jobs and the job counts.",
  input: v.strictObject({}),
  kind: "read",
  name: "queue.list",
  run: async () => (await runtime()).listQueues(),
})

const send = defineQueueOperation<QueueSendOperationInput, QueueSendOperationResult>({
  cli: { namespace: "queue", positional: ["queue", "payload"] },
  description: "Send one job to a Queue Definition. The payload is a JSON value.",
  input: v.strictObject({
    delaySeconds: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
    idempotencyKey: v.optional(v.pipe(v.string(), v.minLength(1))),
    payload: v.unknown(),
    queue: v.pipe(v.string(), v.minLength(1)),
  }),
  invoke: true,
  kind: "write",
  name: "queue.send",
  run: async input => (await runtime()).sendToQueue(input),
})

const queueName = v.pipe(v.string(), v.minLength(1))
const jobId = v.pipe(v.string(), v.minLength(1))

function nextTime(job: LocalQueueJob): string {
  if (job.state === "dead") return job.failedAt ?? "-"
  return job.state === "running" ? "now" : job.availableAt
}

function formatJobs(result: QueueJobsListResult): string {
  const header = `Jobs in ${result.base} (${result.rules} rules)\n`
  if (result.jobs.length === 0) return `${header}No jobs.\n`
  return `${header}${table([
    ["JOB", "QUEUE", "STATE", "ATTEMPTS", "NEXT OR FAILED AT", "ERROR"],
    ...result.jobs.map(job => [job.id, job.queue, job.state, String(job.attempts), nextTime(job), job.error?.message ?? "-"]),
  ])}\n`
}

function formatJob({ job }: { job: LocalQueueJobDetail }): string {
  return [
    `Job: ${job.id}`,
    `Queue: ${job.queue}`,
    `State: ${job.state}`,
    `Attempts: ${job.attempts}`,
    `Enqueued at: ${job.enqueuedAt}`,
    `${job.state === "dead" ? "Failed at" : "Next delivery"}: ${nextTime(job)}`,
    ...(job.expiresAt ? [`Expires at: ${job.expiresAt}`] : []),
    ...(job.idempotencyKey ? [`Idempotency key: ${job.idempotencyKey}`] : []),
    ...(job.error ? [`Error: ${job.error.code ? `${job.error.code} ` : ""}${job.error.message}`] : []),
    ...(job.error?.stack ? ["Stack:", job.error.stack] : []),
    ...(job.file ? [`File: ${job.file}`] : []),
    "Payload:",
    JSON.stringify(job.payload ?? null, null, 2),
    "",
  ].join("\n")
}

const jobsList = defineQueueOperation<QueueJobsListInput, QueueJobsListResult>({
  cli: { command: "jobs list", format: formatJobs, namespace: "queue" },
  description: "List the stored Queue jobs, newest first: pending, running, and dead jobs, from the local or postgres provider. In `vite dev` every job runs in the dev server, so this lists them for any provider.",
  input: v.strictObject({
    queue: v.optional(queueName),
    state: v.optional(v.picklist(["dead", "pending", "running"])),
  }),
  kind: "read",
  name: "queue.jobs-list",
  run: async input => (await runtime()).listQueueJobs(input),
})

const jobsShow = defineQueueOperation<{ id: string }, { job: LocalQueueJobDetail }>({
  cli: { command: "jobs show", format: formatJob, namespace: "queue", positional: ["id"] },
  description: "Show one stored Queue job by message ID, with its payload, attempts, and last error.",
  input: v.strictObject({ id: jobId }),
  kind: "read",
  name: "queue.jobs-show",
  run: async input => (await runtime()).showQueueJob(input.id),
})

const jobsRetry = defineQueueOperation<{ id: string }, { job: LocalQueueJob }>({
  cli: { command: "jobs retry", namespace: "queue", positional: ["id"] },
  description: "Run a stored Queue job now. A dead job gets a new set of attempts. The call returns before the handler ends.",
  input: v.strictObject({ id: jobId }),
  invoke: true,
  kind: "write",
  name: "queue.jobs-retry",
  run: async input => (await runtime()).retryQueueJob(input.id),
})

const jobsClear = defineQueueOperation<QueueJobsClearInput, { cleared: number }>({
  cli: { command: "jobs clear", format: ({ cleared }) => `Removed ${cleared} job${cleared === 1 ? "" : "s"}.\n`, namespace: "queue" },
  description: "Remove the stored Queue jobs that match, pending and dead. Running jobs stay.",
  input: v.strictObject({
    queue: v.optional(queueName),
    state: v.optional(v.picklist(["dead", "pending"])),
  }),
  kind: "destructive",
  name: "queue.jobs-clear",
  run: async input => (await runtime()).clearQueueJobs(input),
})

/**
 * The `queue.*` operations: list and send, and the stored jobs of the local and postgres providers. `vite dev` runs
 * every job with the local provider. Cloudflare and Vercel do not let a producer read their queue, so the job
 * operations fail there.
 */
export const queueOperations: readonly AnyOperation[] = [list, send, jobsList, jobsShow, jobsRetry, jobsClear]

export type { LocalQueueJob, LocalQueueJobDetail, QueueJobsClearInput, QueueJobsListInput, QueueJobsListResult, QueueListResult, QueueSendOperationInput, QueueSendOperationResult }
