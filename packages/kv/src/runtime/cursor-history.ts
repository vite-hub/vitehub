const MAX_CURSOR_HISTORIES = 1_024
const MAX_CURSORS_PER_HISTORY = 1_024
type CursorHistory = Set<string>
interface Continuation { providerCursor: string, history: CursorHistory }

function encodeContinuation(id: number, providerCursor: string, history: CursorHistory): string {
  return `vhc:${id}:${encodeURIComponent(JSON.stringify({ providerCursor, history: [...history] }))}`
}

function decodeContinuation(cursor: string): Continuation | undefined {
  if (!cursor.startsWith("vhc:")) return undefined
  const separator = cursor.indexOf(":", 4)
  if (separator === -1) return undefined
  try {
    const value: unknown = JSON.parse(decodeURIComponent(cursor.slice(separator + 1)))
    if (!value || typeof value !== "object") return undefined
    const data = value as { providerCursor?: unknown, history?: unknown }
    if (typeof data.providerCursor !== "string" || !Array.isArray(data.history) || !data.history.every(item => typeof item === "string")) return undefined
    return { providerCursor: data.providerCursor, history: new Set(data.history) }
  } catch {
    return undefined
  }
}

/** Keeps continuation history tied to an opaque, traversal-owned token. */
export function createCursorHistory() {
  const continuations = new Map<string, Continuation>()
  let nextId = 0
  function take(cursor: string): Continuation {
    const continuation = continuations.get(cursor)
    if (!continuation) {
      // Continuations carry their traversal history so they remain safe when
      // resumed by another driver instance.
      const portable = decodeContinuation(cursor)
      if (portable) return portable
      return { providerCursor: cursor, history: new Set<string>() }
    }
    continuations.delete(cursor)
    return continuation
  }
  function store(providerCursor: string, history: CursorHistory): string {
    const token = encodeContinuation(nextId++, providerCursor, history)
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

/** Records a provider cursor, refusing to weaken repeat detection at the bound. */
export function recordCursor(history: CursorHistory, cursor: string): boolean {
  if (history.size >= MAX_CURSORS_PER_HISTORY) return false
  history.add(cursor)
  return true
}
