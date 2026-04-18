import type { QueueDefinition, QueueDefinitionOptions, QueueHandler } from "./types.ts"

const allowedDefinitionOptions = new Set<keyof QueueDefinitionOptions>([
  "cache",
  "callbackOptions",
  "concurrency",
  "onError",
])

export function defineQueue<TPayload = unknown, TResult = unknown>(
  handler: QueueHandler<TPayload, TResult>,
  options?: QueueDefinitionOptions,
): QueueDefinition<TPayload, TResult> {
  if (typeof handler !== "function") {
    throw new TypeError("`defineQueue()` requires a queue handler.")
  }

  if (options) {
    for (const key of Object.keys(options)) {
      if (!allowedDefinitionOptions.has(key as keyof QueueDefinitionOptions)) {
        throw new TypeError(`Unknown queue definition option \`${key}\`.`)
      }
    }
  }

  return { handler, options }
}
