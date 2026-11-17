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
