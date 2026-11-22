import { logFailure } from "@vite-hub/internal/runtime/request-log"

interface LocalWaitUntil {
  flush(): Promise<void>
  waitUntil(promise: PromiseLike<unknown>): void
}

function createLocalWaitUntil(): LocalWaitUntil {
  const pending = new Set<Promise<unknown>>()
  let error: unknown
  let failed = false

  return {
    async flush() {
      while (pending.size > 0) {
        await Promise.allSettled(pending)
      }
      if (failed) throw error
    },
    waitUntil(value) {
      const promise = Promise.resolve(value)
      pending.add(promise)
      void promise.then(
        () => pending.delete(promise),
        (reason) => {
          pending.delete(promise)
          if (!failed) error = reason
          failed = true
        },
      )
    },
  }
}
/** Complete local deferred work while preserving a handler's failure over a deferred failure. */
export async function runWithScheduleWaitUntil<T>(
  run: (waitUntil: LocalWaitUntil["waitUntil"]) => T | Promise<T>,
  hostWaitUntil?: LocalWaitUntil["waitUntil"],
): Promise<T> {
  if (hostWaitUntil) return await run(hostWaitUntil)

  const local = createLocalWaitUntil()
  let result: T
  try {
    result = await run(local.waitUntil)
  }
  catch (error) {
    await local.flush().catch(logDeferredFailure)
    throw error
  }
  await local.flush()
  return result
}

function logDeferredFailure(error: unknown): void {
  logFailure({ field: "schedule", fields: { op: "wait-until" }, level: "error", message: "Schedule deferred work failed after the handler failed", error }, () => console.error("[vitehub:schedule] Deferred work failed after the handler failed.", error))
}
