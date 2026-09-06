import type { QueueDefinition, QueueDefinitionOptions, QueueHandler } from "./types.ts"
import { queueErrorDiagnostics } from "./error-diagnostics.ts"

export function defineQueue<TPayload = unknown, TResult = unknown>(handler: QueueHandler<TPayload, TResult>, options?: QueueDefinitionOptions): QueueDefinition<TPayload, TResult> {
  if (typeof handler !== "function") {
    throw queueErrorDiagnostics.QUEUE_C0004({ message: "`defineQueue()` requires a queue handler." })
  }

  return { handler, options }
}
