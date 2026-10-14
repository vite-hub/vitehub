const MAX_CURSOR_HISTORIES = 1_024
const MAX_CURSORS_PER_HISTORY = 1_024
const MAX_CURSOR_LENGTH = 8 * 1_024
const MAX_CONTINUATION_LENGTH = 128 * 1_024
type CursorHistory = Set<string>
interface Continuation { providerCursor: string, history: CursorHistory }

function isString(value: unknown): value is string {
  return Object.prototype.toString.call(value) === "[object String]"
}

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

function decodeContinuation(cursor: string): Continuation | undefined {
  if (!cursor.startsWith("vhc1:")) return undefined
  if (cursor.length > MAX_CONTINUATION_LENGTH) return undefined
  const separator = cursor.indexOf(":", 5)
  const tagSeparator = cursor.lastIndexOf(":")
  if (separator === -1 || tagSeparator <= separator || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cursor.slice(5, separator))) return undefined
  const payload = cursor.slice(separator + 1, tagSeparator)
  if (!/^[0-9a-f]{32}$/.test(cursor.slice(tagSeparator + 1)) || continuationTag(payload) !== cursor.slice(tagSeparator + 1)) return undefined
  try {
    const value: unknown = JSON.parse(decodeURIComponent(payload))
    if (!value || typeof value !== "object") return undefined
    const data = value as { format?: unknown, providerCursor?: unknown, history?: unknown }
    if (data.format !== "vitehub-continuation") return undefined
    if (!isString(data.providerCursor) || data.providerCursor.length > MAX_CURSOR_LENGTH) return undefined
    if (!Array.isArray(data.history) || data.history.length > MAX_CURSORS_PER_HISTORY) return undefined
    if (!data.history.every(item => isString(item) && item.length <= MAX_CURSOR_LENGTH)) return undefined
    return { providerCursor: data.providerCursor, history: new Set(data.history) }
  } catch {
    return undefined
  }
}

/** Keeps continuation history tied to an opaque, traversal-owned token. */
export function createCursorHistory() {
  const continuations = new Map<string, Continuation>()
  function take(cursor: string): Continuation {
    const continuation = continuations.get(cursor)
    if (!continuation) {
      // Continuations carry their traversal history so they remain safe when
      // resumed by another driver instance.
      const portable = decodeContinuation(cursor)
      if (portable) return portable
      // A prefix alone does not identify a portable token: providers own opaque cursors.
      if (cursor.length > MAX_CURSOR_LENGTH) {
        throw new Error("ViteHub continuation cursor is invalid or exceeds the maximum size.")
      }
      return { providerCursor: cursor, history: new Set([cursor]) }
    }
    continuations.delete(cursor)
    return continuation
  }
  function store(providerCursor: string, history: CursorHistory): string {
    const token = encodeContinuation(providerCursor, history)
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
  if (cursor.length > MAX_CURSOR_LENGTH || history.size >= MAX_CURSORS_PER_HISTORY) return false
  history.add(cursor)
  return true
}
