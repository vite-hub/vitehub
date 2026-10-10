const MAX_CURSOR_HISTORIES = 1_024
type CursorHistory = Set<string>
interface Continuation { providerCursor: string, history: CursorHistory }

/** Keeps continuation history tied to an opaque, traversal-owned token. */
export function createCursorHistory() {
  const continuations = new Map<string, Continuation>()
  let nextId = 0
  function take(cursor: string): Continuation {
    const continuation = continuations.get(cursor)
    if (!continuation) return { providerCursor: cursor, history: new Set<string>() }
    continuations.delete(cursor)
    return continuation
  }
  function store(providerCursor: string, history: CursorHistory): string {
    const token = `vhc:${nextId++}:${providerCursor}`
    continuations.set(token, { providerCursor, history })
    while (continuations.size > MAX_CURSOR_HISTORIES) {
      const oldest = continuations.keys().next().value as string | undefined
      if (oldest === undefined) break
      continuations.delete(oldest)
    }
    return token
  }
  return { take, store }
}
