const MAX_CURSOR_HISTORIES = 1_024
const MAX_CURSORS_PER_HISTORY = 1_024
const MAX_CURSOR_LENGTH = 8 * 1_024
const MAX_CONTINUATION_LENGTH = 128 * 1_024
type CursorHistory = Set<string>
interface Continuation { providerCursor: string | undefined, history: CursorHistory }

function continuationTag(value: string): string {
  const hashes = [2166136261, 2246822519, 3266489917, 668265263]
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    for (let hashIndex = 0; hashIndex < hashes.length; hashIndex++) {
      hashes[hashIndex] = Math.imul(hashes[hashIndex] ^ code, 16777619 + hashIndex * 2)
    }
  }
  return hashes.map(hash => (hash >>> 0).toString(16).padStart(8, "0")).join("")
}

function encodeContinuation(providerCursor: string, history: CursorHistory): string {
  // A random nonce makes accidental provider-cursor collisions impractical.
  // The nonce is carried in the token so continuations remain portable.
  const nonce = globalThis.crypto.randomUUID()
  const payload = encodeURIComponent(JSON.stringify({ format: "vitehub-continuation", providerCursor, history: [...history] }))
  const token = `vhc1:${nonce}:${payload}:${continuationTag(payload)}`
  if (token.length > MAX_CONTINUATION_LENGTH) throw new Error("ViteHub continuation cursor exceeds the maximum size.")
  return token
}

// Continuation ownership is established only by this registry. Never decode a
// caller-provided cursor, since providers own the complete opaque cursor space.
const continuations = new Map<string, Continuation>()

/** Keeps continuation history tied to an opaque, traversal-owned token. */
export function createCursorHistory() {
  const ownedContinuations = new Set<string>()
  function take(cursor: string): Continuation {
    const continuation = continuations.get(cursor)
    if (!continuation) {
      // A prefix alone does not identify a portable token: providers own opaque cursors.
      if (cursor.length > MAX_CURSOR_LENGTH) {
        throw new Error("ViteHub continuation cursor is invalid or exceeds the maximum size.")
      }
      return { providerCursor: cursor, history: new Set([cursor]) }
    }
    continuations.delete(cursor)
    ownedContinuations.delete(cursor)
    return continuation
  }
  function store(providerCursor: string, history: CursorHistory): string {
    const token = encodeContinuation(providerCursor, history)
    continuations.set(token, { providerCursor, history })
    ownedContinuations.add(token)
    while (continuations.size > MAX_CURSOR_HISTORIES) {
      const oldest = continuations.keys().next().value as string | undefined
      if (oldest === undefined) break
      continuations.delete(oldest)
      ownedContinuations.delete(oldest)
    }
    return token
  }
  function restore(cursor: string, continuation: Continuation): void {
    continuations.set(cursor, continuation)
    ownedContinuations.add(cursor)
  }
  function clear(): void {
    for (const token of ownedContinuations) continuations.delete(token)
    ownedContinuations.clear()
  }
  return { take, store, restore, clear }
}

/** Records a provider cursor, refusing to weaken repeat detection at the bound. */
export function recordCursor(history: CursorHistory, cursor: string): boolean {
  if (cursor.length > MAX_CURSOR_LENGTH || history.size >= MAX_CURSORS_PER_HISTORY) return false
  history.add(cursor)
  return true
}
