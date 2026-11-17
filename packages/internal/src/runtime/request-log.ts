/**
 * The part of evlog's request logger that ViteHub packages write to. `set` adds fields to the request's wide event,
 * `warn` and `error` also raise its level. ViteHub does not depend on evlog: an app that registers evlog gives each
 * request one of these.
 */
export interface RequestLog {
  set: (fields: Record<string, unknown>) => void
  warn: (message: string, fields?: Record<string, unknown>) => void
  error: (error: Error | string, fields?: Record<string, unknown>) => void
}

function isRequestLog(value: unknown): value is RequestLog {
  return value !== null && typeof value === "object"
    && typeof Reflect.get(value, "set") === "function"
    && typeof Reflect.get(value, "warn") === "function"
    && typeof Reflect.get(value, "error") === "function"
}

function contextLog(value: unknown): unknown {
  const context: unknown = value !== null && typeof value === "object" ? Reflect.get(value, "context") : undefined
  return context !== null && typeof context === "object" ? Reflect.get(context, "log") : undefined
}

/**
 * The evlog request logger of a request, or `undefined` when the app does not register evlog. Pass a Nitro v3 event
 * (evlog sets `event.req.context.log`) or its `Request` (`request.context.log`).
 */
export function requestLog(input: unknown): RequestLog | undefined {
  const request: unknown = input !== null && typeof input === "object" ? Reflect.get(input, "req") : undefined
  const log = contextLog(request) ?? contextLog(input)
  return isRequestLog(log) ? log : undefined
}

/** The part of evlog's standalone logger that ViteHub uses. evlog's `createLogger` fits it. */
export interface StandaloneLogger {
  info: (message: string) => void
  warn: (message: string) => void
  error: (error: Error | string) => void
  emit: () => unknown
}

/**
 * What the `vitehub()` Nitro plugin gives ViteHub packages when the app registers evlog's Nitro module: evlog's
 * `createLogger`, and `drain`, which sends an emitted event to the app's `evlog:drain` hooks.
 */
export interface EvlogBridge {
  createLogger: (fields: Record<string, unknown>) => StandaloneLogger
  drain?: (event: unknown) => unknown
  /** `false` when the app turned evlog off with `enabled: false`. ViteHub packages then print to the console. */
  isEnabled?: () => boolean
}

/**
 * The `Symbol.for()` key of the bridge on `globalThis`. Every bundled copy of this module and the Nitro plugin that
 * `vitehub()` generates use the same key.
 */
export const evlogBridgeKey = "vitehub.evlog"

type BridgeGlobal = typeof globalThis & { [key: symbol]: unknown }

function isEvlogBridge(value: unknown): value is EvlogBridge {
  return value !== null && typeof value === "object" && typeof Reflect.get(value, "createLogger") === "function"
}

/** The evlog bridge of this process, or `undefined` when the app does not register evlog. */
export function evlogBridge(): EvlogBridge | undefined {
  const runtime: BridgeGlobal = globalThis
  const bridge = runtime[Symbol.for(evlogBridgeKey)]
  return isEvlogBridge(bridge) ? bridge : undefined
}

/** Sets or removes the evlog bridge of this process. The generated Nitro plugin and tests call it. */
export function setEvlogBridge(bridge: EvlogBridge | undefined): void {
  const runtime: BridgeGlobal = globalThis
  if (bridge) runtime[Symbol.for(evlogBridgeKey)] = bridge
  else delete runtime[Symbol.for(evlogBridgeKey)]
}

/** One log event of a ViteHub package: `{ action: field, message, [field]: fields }`, such as `field: "blob"`. */
export interface PrimitiveLogEvent {
  field: string
  fields: Record<string, unknown>
  level: "info" | "warn" | "error"
  message: string
  error?: unknown
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * A short name for the cause of a failure, safe to put in a log field: the string `code` of the error, such as
 * `ENOSPC` or a ViteHub diagnostic code, else its class name. Never the message, which can hold paths or values.
 */
export function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined
  const code: unknown = Reflect.get(error, "code")
  if (typeof code === "string" && code) return code
  const name: unknown = Reflect.get(error, "name")
  return typeof name === "string" && name && name !== "Error" ? name : undefined
}

/**
 * Emits one evlog event of its own, outside a request's wide event. The event also reaches the app's `evlog:drain`
 * hooks. Returns `false` when the app does not register evlog or turned it off, and never throws.
 */
export function emitLogEvent(event: PrimitiveLogEvent): boolean {
  const bridge = evlogBridge()
  if (!bridge) return false
  try {
    if (bridge.isEnabled?.() === false) return false
    const log = bridge.createLogger({ action: event.field, message: event.message, [event.field]: event.fields })
    if (event.level === "error") log.error(event.error instanceof Error ? event.error : event.error === undefined ? event.message : `${event.message}: ${errorText(event.error)}`)
    else log[event.level](event.error === undefined ? event.message : `${event.message}: ${errorText(event.error)}`)
    const emitted = log.emit()
    if (emitted && bridge.drain) void Promise.resolve(bridge.drain(emitted)).catch(() => {})
    return true
  }
  catch {
    return false
  }
}

/**
 * Logs a failure that the caller survives. With the evlog request logger of `request`, it sets `[field]` on the
 * request's wide event and adds a warning. Pass `request` only when the request has not answered yet: evlog drops
 * fields after it emits the wide event. Otherwise it emits an event of its own. Without evlog, it calls `fallback`,
 * which prints to the console as before. It never throws.
 */
export function logFailure(failure: Omit<PrimitiveLogEvent, "level"> & { level?: "warn" | "error", request?: unknown }, fallback: () => void): void {
  const code = errorCode(failure.error)
  const fields = { ...failure.fields, ...(code ? { code } : {}) }
  const log = failure.request === undefined ? undefined : requestLog(failure.request)
  if (log) {
    try {
      log.warn(failure.error === undefined ? failure.message : `${failure.message}: ${errorText(failure.error)}`, { [failure.field]: fields })
      return
    }
    catch {}
  }
  if (emitLogEvent({ ...failure, fields, level: failure.level ?? "warn" })) return
  try {
    fallback()
  }
  catch {}
}
