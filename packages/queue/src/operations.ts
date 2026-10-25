import { defineOperation } from "@vite-hub/internal/operations"
import * as v from "valibot"

import type { AnyOperation, OperationDefinition } from "@vite-hub/internal/operations"
import type { QueueListResult, QueueSendOperationInput, QueueSendOperationResult } from "./runtime/operations.ts"

// The runtime module reaches the Queue configuration that the generated server installs. The operations load it when
// they run, so the CLI and `vitehub inspect` can list them without it.
const runtime = () => import("./runtime/operations.ts")

function defineQueueOperation<Input, Output>(definition: Omit<OperationDefinition<Input, Output>, "section" | "user">): OperationDefinition<Input, Output> {
  // The Queue runtime answers for the section. The operations never read the signed-in user.
  return defineOperation({ ...definition, section: "queues", user: false })
}

const list = defineQueueOperation<Record<string, never>, QueueListResult>({
  description: "List the Queue Definitions of the app and the provider that sends their jobs.",
  input: v.strictObject({}),
  kind: "read",
  name: "queue.list",
  run: async () => (await runtime()).listQueues(),
})

const send = defineQueueOperation<QueueSendOperationInput, QueueSendOperationResult>({
  cli: { positional: ["queue", "payload"] },
  description: "Send one job to a Queue Definition. The payload is a JSON value.",
  input: v.strictObject({
    delaySeconds: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
    id: v.optional(v.pipe(v.string(), v.minLength(1))),
    idempotencyKey: v.optional(v.pipe(v.string(), v.minLength(1))),
    payload: v.unknown(),
    queue: v.pipe(v.string(), v.minLength(1)),
  }),
  kind: "write",
  name: "queue.send",
  run: async input => (await runtime()).sendToQueue(input),
})

/**
 * The `queue.*` operations: list and send. The provider-independent Queue contract has no way to read a backlog, so
 * there is no peek.
 */
export const queueOperations: readonly AnyOperation[] = [list, send]

export type { QueueListResult, QueueSendOperationInput, QueueSendOperationResult }
