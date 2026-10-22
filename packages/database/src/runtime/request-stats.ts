import { AsyncLocalStorage } from "node:async_hooks"

/** The database work of one request, as its wide event shows it under `database`. */
export interface DatabaseRequestStats {
  /** Calls to a database. A batch is one call. */
  calls: number
  /** Milliseconds with at least one call in flight: how long the request waited for its databases. */
  ms: number
  /** The most calls in flight at the same time. 1 means every call waited for the one before it. */
  maxConcurrent: number
}

interface RequestStatsState {
  stats: DatabaseRequestStats
  inFlight: number
  since: number
}

interface RequestLogger {
  set: (fields: Record<string, unknown>) => void
}

// One store per runtime, also when the bundle holds more than one copy of this module.
const storageKey = Symbol.for("vitehub.database.request-stats")
const runtimeGlobal = globalThis as typeof globalThis & Record<symbol, unknown>
const storage = (runtimeGlobal[storageKey] ||= new AsyncLocalStorage<RequestStatsState>()) as AsyncLocalStorage<RequestStatsState>

/** The evlog request logger on a Nitro v3 event (`event.req.context.log`), when the app registers evlog. */
function requestLogger(event: unknown): RequestLogger | undefined {
  const log: unknown = Reflect.get(Object(Reflect.get(Object(Reflect.get(Object(event), "req")), "context")), "log")
  const set: unknown = log && Reflect.get(Object(log), "set")
  return typeof set === "function" ? { set: fields => Reflect.apply(set, log, [fields]) } : undefined
}

/**
 * Nitro middleware: runs the rest of the request with its own database stats, and sets them on the request's wide event
 * (`database`) once the handler settles. Without an evlog request logger, the request runs as it is.
 * Work that continues after the response, such as `waitUntil()`, is not counted.
 */
export function runWithDatabaseRequestStats(event: unknown, next: () => unknown): unknown {
  const log = requestLogger(event)
  if (!log) return next()
  const state: RequestStatsState = { stats: { calls: 0, ms: 0, maxConcurrent: 0 }, inFlight: 0, since: 0 }
  const report = () => {
    if (state.stats.calls) log.set({ database: { ...state.stats, ms: Math.round(state.stats.ms) } })
  }
  return storage.run(state, async () => {
    try {
      return await next()
    }
    finally {
      report()
    }
  })
}

/** Runs one call to a database and counts it for the active request. Outside a measured request, it only runs it. */
export function trackDatabaseCall<T>(call: () => PromiseLike<T>): Promise<T> {
  const state = storage.getStore()
  if (!state) return Promise.resolve(call())
  if (state.inFlight++ === 0) state.since = performance.now()
  state.stats.calls++
  state.stats.maxConcurrent = Math.max(state.stats.maxConcurrent, state.inFlight)
  const settle = () => {
    if (--state.inFlight === 0) state.stats.ms += performance.now() - state.since
  }
  let pending: PromiseLike<T>
  try {
    pending = call()
  }
  catch (error) {
    settle()
    return Promise.reject(error)
  }
  return Promise.resolve(pending).finally(settle)
}

/**
 * Drizzle's `$client` stays the client the app configured, so `db.$client` is still the binding or the driver's client.
 * Only Drizzle's own queries go through the counting client.
 */
export function keepOwnClient<TDatabase extends object>(db: TDatabase, client: unknown): TDatabase {
  Reflect.set(db, "$client", client)
  return db
}

interface D1StatementLike {
  bind: (...params: unknown[]) => D1StatementLike
}

const trackedD1 = new WeakSet<object>()

/** Counts each run of a D1 statement. Statements stay the binding's own objects, so `batch()` still accepts them. */
function trackD1Statement<TStatement extends D1StatementLike>(statement: TStatement): TStatement {
  if (trackedD1.has(statement)) return statement
  trackedD1.add(statement)
  for (const name of ["all", "raw", "run", "first"]) {
    const original: unknown = Reflect.get(statement, name)
    if (typeof original !== "function") continue
    Reflect.set(statement, name, (...args: unknown[]) => trackDatabaseCall(() => Reflect.apply(original, statement, args)))
  }
  const bind = statement.bind
  Reflect.set(statement, "bind", (...params: unknown[]) => trackD1Statement(Reflect.apply(bind, statement, params)))
  return statement
}

/** A Cloudflare D1 binding that counts every statement run and every batch for the active request. */
export function trackD1Database<TDatabase extends object>(database: TDatabase): TDatabase {
  return new Proxy(database, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target)
      if (typeof value !== "function") return value
      if (property === "prepare") return (query: string) => trackD1Statement(Reflect.apply(value, target, [query]))
      if (property === "batch" || property === "exec")
        return (...args: unknown[]) => trackDatabaseCall(() => Reflect.apply(value, target, args))
      return value.bind(target)
    },
  })
}

const LIBSQL_CALLS = new Set(["execute", "batch", "migrate", "executeMultiple", "commit", "rollback"])

/** A libSQL client, or one of its transactions, that counts every call for the active request. */
export function trackLibsqlClient<TClient extends object>(client: TClient): TClient {
  return new Proxy(client, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target)
      if (typeof value !== "function") return value
      if (typeof property === "string" && LIBSQL_CALLS.has(property))
        return (...args: unknown[]) => trackDatabaseCall(() => Reflect.apply(value, target, args))
      // A transaction runs its own statements; count those too.
      if (property === "transaction")
        return async (...args: unknown[]) => trackLibsqlClient(Object(await trackDatabaseCall(() => Reflect.apply(value, target, args))))
      return value.bind(target)
    },
  })
}

/** A postgres.js query: it runs when it is first awaited, so that is where it is counted. */
function trackPostgresQuery<TQuery extends object>(query: TQuery): TQuery {
  const then: unknown = Reflect.get(query, "then")
  if (typeof then !== "function") return query
  let counted: Promise<unknown> | undefined
  Reflect.set(query, "then", (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) => {
    counted ??= trackDatabaseCall(() => new Promise((resolve, reject) => Reflect.apply(then, query, [resolve, reject])))
    return counted.then(onFulfilled, onRejected)
  })
  return query
}

/** A postgres.js client, or a transaction's client, that counts every query for the active request. */
export function trackPostgresClient<TClient extends object>(client: TClient): TClient {
  return new Proxy(client, {
    apply(target, thisArg, args) {
      return trackPostgresQuery(Reflect.apply(target as unknown as Function, thisArg, args) as object)
    },
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target)
      if (typeof value !== "function") return value
      if (property === "unsafe") return (...args: unknown[]) => trackPostgresQuery(Reflect.apply(value, target, args))
      // Transactions and savepoints hand their callback a client of their own.
      if (property === "begin" || property === "savepoint") {
        return (...args: unknown[]) => Reflect.apply(value, target, args.map(arg => typeof arg === "function"
          ? (transaction: object, ...rest: unknown[]) => Reflect.apply(arg, undefined, [trackPostgresClient(transaction), ...rest])
          : arg))
      }
      return value.bind(target)
    },
  })
}
