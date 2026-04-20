import type { QueueDefinition, QueueDefinitionOptions, QueueHandler } from "./types.ts"

export function defineQueue<TPayload = unknown, TResult = unknown>(handler: QueueHandler<TPayload, TResult>, options?: QueueDefinitionOptions): QueueDefinition<TPayload, TResult> {
  if (typeof handler !== "function") {
    throw new TypeError("`defineQueue()` requires a queue handler.")
  }

  return { handler, options }
}
