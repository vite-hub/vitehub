interface Continuation<T> {
  value: T
  bytes: number
  timeout: ReturnType<typeof setTimeout>
}

/** Owns process-local cursor retention. Taking a cursor transfers its resource to the caller. */
export function createKVContinuations<T>(options: {
  release?: (value: T) => Promise<unknown>
  maximumBytes?: number
  expired: () => Error
}) {
  const entries = new Map<string, Continuation<T>>()
  const releases = new Set<Promise<void>>()
  const failures: unknown[] = []
  let bytes = 0
  let disposed = false

  function take(cursor: string): T | undefined {
    const entry = entries.get(cursor)
    if (!entry) return undefined
    clearTimeout(entry.timeout)
    entries.delete(cursor)
    bytes -= entry.bytes
    return entry.value
  }

  function release(value: T, surfaceFailure = false): Promise<void> {
    const pending: Promise<void> = Promise.resolve().then(() => options.release?.(value)).then(() => undefined).catch((error: unknown) => {
      if (failures.length === 0) failures.push(error)
      if (surfaceFailure) throw error
    }).finally(() => { releases.delete(pending) })
    releases.add(pending)
    return pending
  }

  function evict(cursor: string): void {
    const value = take(cursor)
    if (value !== undefined) void release(value)
  }

  return {
    take,
    async retain(value: T, size = 0): Promise<string> {
      if (disposed) {
        await release(value, true)
        throw options.expired()
      }
      while (entries.size >= 32 || bytes + size > (options.maximumBytes ?? Number.POSITIVE_INFINITY)) {
        const oldest = entries.keys().next().value
        if (!oldest) break
        evict(oldest)
      }
      const cursor = globalThis.crypto.randomUUID()
      const timeout = setTimeout(() => evict(cursor), 15 * 60_000)
      // SAFETY: Node timers expose unref; web-runtime timers are numbers.
      ;(timeout as { unref?: () => void }).unref?.()
      entries.set(cursor, { value, bytes: size, timeout })
      bytes += size
      return cursor
    },
    async dispose(): Promise<void> {
      disposed = true
      for (const cursor of entries.keys()) evict(cursor)
      await Promise.all(releases)
      if (failures.length > 0) throw new AggregateError(failures.splice(0), "Failed to release KV listing continuations.")
    },
  }
}
