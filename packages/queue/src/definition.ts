import type {
  CreateQueueDefinitionInput,
  QueueDefinition,
  QueueDefinitionOptions,
  QueueHandler,
} from "./types.ts"

const allowedDefinitionOptions = new Set([
  "cache",
  "callbackOptions",
  "concurrency",
  "onError",
])

function validateDefinitionOptions(options: QueueDefinitionOptions | undefined) {
  if (!options) return undefined

  for (const key of Object.keys(options)) {
    if (!allowedDefinitionOptions.has(key)) {
      throw new TypeError(`Unknown queue definition option \`${key}\`.`)
    }
  }

  return options
}

export function createQueue<TPayload = unknown, TResult = unknown>(
  input: CreateQueueDefinitionInput<TPayload, TResult>,
): QueueDefinition<TPayload, TResult> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("`createQueue()` accepts a single options object with a `handler` property.")
  }

  const { handler, ...options } = input
  if (typeof handler !== "function") {
    throw new TypeError("`createQueue()` requires a queue handler in `handler`.")
  }

  return {
    handler,
    options: validateDefinitionOptions(Object.keys(options).length > 0 ? options : undefined),
  }
}

export function defineQueue<TPayload = unknown, TResult = unknown>(
  handler: QueueHandler<TPayload, TResult>,
  options?: QueueDefinitionOptions,
): QueueDefinition<TPayload, TResult> {
  if (typeof handler !== "function") {
    throw new TypeError("`defineQueue()` requires a queue handler.")
  }

  return {
    handler,
    options: validateDefinitionOptions(options),
  }
}
