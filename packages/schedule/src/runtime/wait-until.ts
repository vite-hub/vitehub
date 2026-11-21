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
  try {
    const result = await run(local.waitUntil)
    await local.flush()
    return result
  }
  catch (error) {
    try {
      await local.flush()
    }
    catch {}
    throw error
  }
}
