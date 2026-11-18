import { isRecord } from "@vite-hub/internal/object"

import type { QueueDefinition } from "./types.ts"
import { queueErrorDiagnostics } from "./error-diagnostics.ts"

const queueDefinitionKeys: ReadonlySet<string> = new Set(["cache", "callbackOptions", "concurrency", "handler", "onDispatchError", "onError"])

/**
 * Defines a Queue from one object: `defineQueue({ handler, concurrency })`. The handler receives one object,
 * `{ payload, id, attempts, metadata }`. The payload type of `handler` types `sendQueue()` for this Queue.
 */
export function defineQueue<TPayload = unknown, TResult = unknown>(definition: QueueDefinition<TPayload, TResult>, ...removed: unknown[]): QueueDefinition<TPayload, TResult> {
  if (typeof definition === "function" || removed.length) {
    throw queueErrorDiagnostics.QUEUE_INVALID_DEFINITION({ reason: "`defineQueue(handler, options)` was removed." })
  }
  if (!isRecord(definition)) {
    throw queueErrorDiagnostics.QUEUE_INVALID_DEFINITION({ reason: "`defineQueue()` expects one object with `handler`." })
  }
  const unknownKey = Object.keys(definition).find(key => !queueDefinitionKeys.has(key))
  if (unknownKey) {
    throw queueErrorDiagnostics.QUEUE_INVALID_DEFINITION({ reason: `\`defineQueue()\` does not support the "${unknownKey}" option.` })
  }
  if (!Object.hasOwn(definition, "handler") || typeof definition.handler !== "function") {
    throw queueErrorDiagnostics.QUEUE_INVALID_DEFINITION({ reason: "`defineQueue()` needs a `handler` function." })
  }

  return definition
}
