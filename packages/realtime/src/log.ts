import { logFailure } from "@vite-hub/internal/runtime/request-log"

/** The `realtime` field of a log event or a wide event. A room of a `document: false` Definition is a hash. */
export interface RealtimeLogFields {
  definition?: string
  room?: string
  /** Why the server refused a connection or a document request, such as `origin` or `authorize`. */
  refused?: string
  /** The HTTP status of the refusal. */
  status?: number
  /** The diagnostic code of the refusal's cause, such as `AUTH_R0007`. */
  code?: string
  /** The close code that the server sent to a connection, such as `4429`. */
  closed?: number
  /** The step that failed, such as `peer`, `save`, or `bus-publish`. */
  failed?: string
}

/** Errors that a log event already has. A failure that two steps see gets one event. */
const logged = new WeakSet<object>()

/**
 * The label of a room in logs. A `document: false` room id can be a random token that lets a person join, such as a
 * page id, so the log gets a short hash of it. A cryptographic hash adds nothing here: a short or guessable id can be
 * found from any hash by trying values.
 */
export function realtimeRoomLabel(documentId: string, presence: boolean): string {
  if (!presence) return documentId
  let hash = 0x811C9DC5
  for (let index = 0; index < documentId.length; index++) {
    hash ^= documentId.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `#${(hash >>> 0).toString(16).padStart(8, "0")}`
}

/** The definition and room of a room key from `realtimeRoomKey()`. Workspace event rooms have no room id. */
export function realtimeRoomFields(key: string, presence: boolean): RealtimeLogFields {
  let parts: unknown
  try {
    parts = JSON.parse(key)
  }
  catch {
    return {}
  }
  if (!Array.isArray(parts)) return {}
  const [definition, documentId] = parts
  return {
    ...typeof definition === "string" ? { definition } : {},
    ...typeof documentId === "string" ? { room: realtimeRoomLabel(documentId, presence) } : {},
  }
}

/**
 * Logs one Realtime failure as its own evlog event, `{ action: "realtime", message, realtime: fields }`, when the app
 * registers evlog and has it on. Otherwise it prints to the console, unless `console` is false. It never throws: it
 * also runs inside a Durable Object and in socket callbacks.
 */
export function logRealtime(level: "warn" | "error", message: string, fields: RealtimeLogFields, error?: unknown, options: { console?: boolean } = {}): void {
  if (typeof error === "object" && error !== null) {
    if (logged.has(error)) return
    logged.add(error)
  }
  logFailure({ field: "realtime", fields: { ...fields }, level, message, ...(error === undefined ? {} : { error }) }, () => {
    if (options.console === false) return
    const text = `[vitehub] ${message}`
    if (level === "error") console.error(text, ...error === undefined ? [] : [error])
    else console.warn(text, ...error === undefined ? [] : [error instanceof Error ? error.message : String(error)])
  })
}
