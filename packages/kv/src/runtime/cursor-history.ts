import { kvErrorDiagnostics } from "../error-diagnostics.ts"

const MAX_CURSOR_HISTORIES = 1_024
const MAX_CURSORS_PER_HISTORY = 1_024
const MAX_CURSOR_LENGTH = 8 * 1_024
const MAX_CONTINUATION_LENGTH = 128 * 1_024
type CursorHistory = Set<string>
interface Continuation { providerCursor: string | undefined, history: CursorHistory, epoch?: number, namespace: string }

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
  // Keep the token size independent of traversal length. The exact history is
  // retained in the process-local registry for repeat detection; the token
  // carries only bounded metadata for diagnostics and format validation.
  const historyTag = continuationTag([...history].join("\u0000"))
  const payload = encodeURIComponent(JSON.stringify({ format: "vitehub-continuation", providerCursor, historyCount: history.size, historyTag }))
  const token = `vhc1:${nonce}:${payload}:${continuationTag(payload)}`
  if (token.length > MAX_CONTINUATION_LENGTH) throw new Error("ViteHub continuation cursor exceeds the maximum size.")
  return token
}

// Continuation ownership is established only by this registry. Never decode a
// caller-provided cursor, since providers own the complete opaque cursor space.
const continuations = new Map<string, Continuation>()
const consumedContinuations = new Map<string, Continuation>()
const consumedOwners = new Map<string, Set<string>>()
const invalidatedContinuations = new Set<string>()

function rememberInvalidated(cursor: string): void {
  invalidatedContinuations.add(cursor)
  while (invalidatedContinuations.size > MAX_CURSOR_HISTORIES) {
    const oldest = invalidatedContinuations.values().next().value as string | undefined
    if (oldest === undefined) break
    invalidatedContinuations.delete(oldest)
  }
}

/** Keeps continuation history tied to an opaque, traversal-owned token. */
export function createCursorHistory(namespace = "default") {
  const ownedContinuations = new Set<string>()
  const ownedConsumedContinuations = new Set<string>()
  let epoch = 0
  function take(cursor: string, requestedNamespace = namespace): Continuation {
    const continuation = continuations.get(cursor)
    if (continuation && continuation.namespace !== requestedNamespace) {
      throw kvErrorDiagnostics.KV_INVALID_CURSOR({ problem: "foreign" })
    }
    if (!continuation) {
      if (consumedContinuations.has(cursor)) {
        throw kvErrorDiagnostics.KV_INVALID_CURSOR({ problem: "in-use" })
      }
      if (invalidatedContinuations.has(cursor)) {
        throw kvErrorDiagnostics.KV_INVALID_CURSOR({ problem: "expired" })
      }
      // A prefix alone does not identify a portable token: providers own opaque cursors.
      if (cursor.length > MAX_CURSOR_LENGTH) {
        throw kvErrorDiagnostics.KV_INVALID_CURSOR({ problem: "invalid" })
      }
      return { providerCursor: cursor, history: new Set([cursor]), epoch, namespace }
    }
    continuations.delete(cursor)
    ownedContinuations.delete(cursor)
    consumedContinuations.set(cursor, continuation)
    ownedConsumedContinuations.add(cursor)
    consumedOwners.set(cursor, ownedConsumedContinuations)
    while (consumedContinuations.size > MAX_CURSOR_HISTORIES) {
      const oldest = consumedContinuations.keys().next().value as string | undefined
      if (oldest === undefined) break
      consumedContinuations.delete(oldest)
      consumedOwners.get(oldest)?.delete(oldest)
      consumedOwners.delete(oldest)
      rememberInvalidated(oldest)
    }
    return continuation
  }
  function store(providerCursor: string, history: CursorHistory, requestedNamespace = namespace): string {
    const token = encodeContinuation(providerCursor, history)
    continuations.set(token, { providerCursor, history, epoch, namespace: requestedNamespace })
    ownedContinuations.add(token)
    while (continuations.size > MAX_CURSOR_HISTORIES) {
      const oldest = continuations.keys().next().value as string | undefined
      if (oldest === undefined) break
      continuations.delete(oldest)
      ownedContinuations.delete(oldest)
      rememberInvalidated(oldest)
    }
    return token
  }
  function restore(cursor: string, continuation: Continuation): void {
    if (continuation.epoch !== epoch || consumedContinuations.get(cursor) !== continuation) return
    continuations.set(cursor, continuation)
    ownedContinuations.add(cursor)
    consumedContinuations.delete(cursor)
    consumedOwners.delete(cursor)
    ownedConsumedContinuations.delete(cursor)
  }
  function complete(cursor: string | undefined): void {
    if (cursor && ownedConsumedContinuations.has(cursor)) {
      consumedContinuations.delete(cursor)
      consumedOwners.delete(cursor)
      ownedConsumedContinuations.delete(cursor)
    }
  }
  function clear(): void {
    epoch++
    for (const token of ownedContinuations) {
      continuations.delete(token)
      rememberInvalidated(token)
    }
    ownedContinuations.clear()
    for (const token of ownedConsumedContinuations) {
      consumedContinuations.delete(token)
      consumedOwners.delete(token)
      rememberInvalidated(token)
    }
    ownedConsumedContinuations.clear()
  }
  return { take, store, restore, complete, clear }
}

/** Records a provider cursor, refusing to weaken repeat detection at the bound. */
export function recordCursor(history: CursorHistory, cursor: string): boolean {
  if (cursor.length > MAX_CURSOR_LENGTH || history.size >= MAX_CURSORS_PER_HISTORY) return false
  history.add(cursor)
  return true
}
