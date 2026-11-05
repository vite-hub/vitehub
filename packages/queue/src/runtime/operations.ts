import { redactInspectionText } from "@vite-hub/internal/inspect"

import { isQueueError, normalizePublicQueueIdentifier } from "../errors.ts"
import { getQueueRuntimeConfig, listQueueDefinitionNames } from "../internal/runtime/state.ts"
import { dynamicQueue } from "./client.ts"

import type { LocalQueueStatus } from "../providers/local.ts"

import type { QueueEnqueueOptions, QueueProvider } from "../types.ts"

export interface QueueListResult {
  /** `undefined` when the runtime has not installed a Queue configuration. */
  provider?: QueueProvider
  /**
   * The local provider only: where the jobs are and what survives. `single-host` jobs survive a restart on this host,
   * but not a move to another host or a new container.
   */
  storage?: { base: string, deadLimit: number, durability: LocalQueueStatus["durability"] }
  /** `dead`, `pending`, and `running` are job counts of the local provider. Hosted providers do not report a backlog. */
  queues: Array<{ dead?: number, name: string, pending?: number, running?: number }>
}

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
