interface LocalWaitUntil {
  flush(): Promise<void>
  waitUntil(promise: PromiseLike<unknown>): void
}

export function createLocalWaitUntil(): LocalWaitUntil {
  const pending = new Set<Promise<unknown>>()
  let error: unknown
  let failed = false

  return {
    async flush() {
      while (pending.size > 0) {
        await Promise.allSettled([...pending])
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
