/**
 * Checks the Response fields that the Agent reads, not one realm's constructor. A Response from another Fetch
 * implementation, such as a bundled undici, `@whatwg-node/fetch` or the srvx Response in Nitro, also matches.
 */
export function isResponse(value: unknown): value is Response {
  if (typeof value !== "object" || value === null) return false
  // SAFETY: each field is checked before the value is narrowed.
  const response = value as { headers?: { get?: unknown } | null, status?: unknown }
  return typeof response.status === "number" && typeof response.headers?.get === "function"
}

/**
 * Returns a body that host stream operations accept. A body from another stream implementation is read through its
 * own reader.
 */
export function hostReadableStream<T>(body: ReadableStream<T>): ReadableStream<T> {
  if (body instanceof ReadableStream) return body
  // SAFETY: a stream from another implementation has the same reader API, but `instanceof` narrows it to `never`.
  const reader = (body as ReadableStream<T>).getReader()
  return new ReadableStream<T>({
    async pull(controller) {
      try {
        const result = await reader.read()
        if (result.done) {
          reader.releaseLock()
          controller.close()
        }
        else controller.enqueue(result.value)
      }
      catch (error) {
        reader.releaseLock()
        controller.error(error)
      }
    },
    cancel: reason => reader.cancel(reason),
  }, { highWaterMark: 0 })
}
