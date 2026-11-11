import { defineErrors } from "./result.ts"

import type { Result } from "./result.ts"

// Keep published codes stable. Each code has a heading on the diagnostics page.
const leaseErrorDiagnostics = /*#__PURE__*/ defineErrors({
  docs: "https://vitehub.dev/docs/development/diagnostics",
  codes: {
    // Runtime errors. Lease operations return them as `[error, undefined]`.
    RUNTIME_LEASE_INVALID_TTL: {
      why: "`ttl` must be a positive number of seconds.",
      fix: "Pass the TTL in seconds, for example `leases.acquire('report:daily', { ttl: 30 })`.",
    },
    RUNTIME_LEASE_FAILED: {
      why: ({ key, operation }: { key: string, operation: LeaseOperation }) => `The lease store could not ${operation} the lease ${JSON.stringify(key)}.`,
      fix: "Read `error.cause` for the store error. Retry when the store is available again.",
    },
  },
})

export type LeaseOperation = "acquire" | "get" | "release" | "renew"

/** The codes that lease operations return. */
export type LeaseErrorCode = "RUNTIME_LEASE_FAILED" | "RUNTIME_LEASE_INVALID_TTL"

/** One live lease as the store keeps it. */
export interface LeaseRecord {
  /** The value that the caller locks, such as `schedule:daily:2026-11-09`. */
  key: string
  /** A new random ID for each acquire. Release and renew act only when the stored ID is still this one. */
  id: string
  /** The label from `acquire()`, such as an instance name. It is for inspection only. */
  owner?: string
  /** When the lease ends, from the clock of the store. */
  expiresAt: Date
}

/** A lease that this caller holds. */
export interface Lease extends LeaseRecord {
  /**
   * Moves the end of the lease to `ttl` seconds from now. The default is the TTL of `acquire()`. Resolves `false` when
   * the lease is no longer this caller's, because another caller acquired it after it expired. On `true`, `expiresAt`
   * has the new end.
   */
  renew(options?: { ttl?: number }): Promise<Result<boolean, LeaseErrorCode>>
  /** Frees the lease. Resolves `false` and changes nothing when another caller holds the key now. */
  release(): Promise<Result<boolean, "RUNTIME_LEASE_FAILED">>
}

export interface LeaseAcquireOptions {
  /** Seconds until the lease ends when the holder does not renew or release it. Fractions are allowed. */
  ttl: number
  /** A label for the holder, such as an instance name. Acquire does not compare it. */
  owner?: string
}

/**
 * Gives one caller at a time a lease on a key. A lease ends at `release()` or when its TTL passes, so a holder that
 * crashes blocks the key only until then. Leases are not reentrant: a held key refuses every other acquire, also from
 * the same owner.
 */
export interface LeaseStore {
  /** Takes the lease when the key is free or its lease expired. Resolves `null` when another caller holds it. */
  acquire(key: string, options: LeaseAcquireOptions): Promise<Result<Lease | null, LeaseErrorCode>>
  /** The live lease on the key, or `null`. */
  get(key: string): Promise<Result<LeaseRecord | null, "RUNTIME_LEASE_FAILED">>
}

/** The storage operations behind a `LeaseStore`. Each one must be atomic. Times are milliseconds since the epoch. */
interface LeaseBackend {
  /** Writes the lease when the key is free or expired, and returns its end. Returns `undefined` when the key is held. */
  acquire(key: string, id: string, owner: string | undefined, ttlMs: number): Promise<number | undefined>
  /** Moves the end of the lease when the stored ID matches, and returns the new end. */
  renew(key: string, id: string, ttlMs: number): Promise<number | undefined>
  /** Deletes the lease when the stored ID matches. */
  release(key: string, id: string): Promise<boolean>
  get(key: string): Promise<{ id: string, owner?: string, expiresAt: number } | undefined>
}

/** Expired leases mean nothing, so stores delete them at most once per this interval. */
const sweepIntervalMs = 60_000

function toTtlMs(ttl: unknown): number | undefined {
  if (typeof ttl !== "number" || !Number.isFinite(ttl) || ttl <= 0) return undefined
  const ms = Math.ceil(ttl * 1000)
  return Number.isSafeInteger(ms) ? ms : undefined
}

async function attempt<T>(operation: LeaseOperation, key: string, run: () => Promise<T>): Promise<Result<T, "RUNTIME_LEASE_FAILED">> {
  try {
    return [undefined, await run()]
  }
  catch (cause) {
    return [leaseErrorDiagnostics.RUNTIME_LEASE_FAILED({ cause, key, operation }), undefined]
  }
}

function createLeaseStore(backend: LeaseBackend): LeaseStore {
  function lease(record: LeaseRecord, defaultTtlMs: number): Lease {
    const held: Lease = {
      ...record,
      async renew(options) {
        const ttlMs = options?.ttl === undefined ? defaultTtlMs : toTtlMs(options.ttl)
        if (ttlMs === undefined) return [leaseErrorDiagnostics.RUNTIME_LEASE_INVALID_TTL(), undefined]
        return attempt("renew", held.key, async () => {
          const expiresAt = await backend.renew(held.key, held.id, ttlMs)
          if (expiresAt === undefined) return false
          held.expiresAt = new Date(expiresAt)
          return true
        })
      },
      release: () => attempt("release", held.key, () => backend.release(held.key, held.id)),
    }
    return held
  }

  return {
    async acquire(key, options) {
      const ttlMs = toTtlMs(options?.ttl)
      if (ttlMs === undefined) return [leaseErrorDiagnostics.RUNTIME_LEASE_INVALID_TTL(), undefined]
      const id = crypto.randomUUID()
      const owner = options.owner
      return attempt("acquire", key, async () => {
        const expiresAt = await backend.acquire(key, id, owner, ttlMs)
        if (expiresAt === undefined) return null
        return lease({ key, id, ...(owner === undefined ? {} : { owner }), expiresAt: new Date(expiresAt) }, ttlMs)
      })
    },
    get: key => attempt("get", key, async () => {
      const record = await backend.get(key)
      return record ? { key, id: record.id, ...(record.owner === undefined ? {} : { owner: record.owner }), expiresAt: new Date(record.expiresAt) } : null
    }),
  }
}

/**
 * Leases in the memory of this process. Use it for one instance and for tests. Several instances need a shared store,
 * such as `createSqlLeaseStore()`.
 */
export function createMemoryLeaseStore(): LeaseStore {
  const leases = new Map<string, { id: string, owner?: string, expiresAt: number }>()
  let sweptAt = 0
  const live = (key: string, now: number) => {
    const entry = leases.get(key)
    return entry && entry.expiresAt > now ? entry : undefined
  }
  return createLeaseStore({
    async acquire(key, id, owner, ttlMs) {
      const now = Date.now()
      if (now - sweptAt >= sweepIntervalMs) {
        sweptAt = now
        for (const [held, entry] of leases) if (entry.expiresAt <= now) leases.delete(held)
      }
      if (live(key, now)) return undefined
      const expiresAt = now + ttlMs
      leases.set(key, { id, ...(owner === undefined ? {} : { owner }), expiresAt })
      return expiresAt
    },
    async renew(key, id, ttlMs) {
      const entry = leases.get(key)
      if (entry?.id !== id) return undefined
      entry.expiresAt = Date.now() + ttlMs
      return entry.expiresAt
    },
    async release(key, id) {
      if (leases.get(key)?.id !== id) return false
      return leases.delete(key)
    },
    async get(key) {
      const entry = live(key, Date.now())
      return entry && { ...entry }
    },
  })
}

/**
 * The SQL connection that `createSqlLeaseStore()` uses. `query()` runs one statement with positional parameters and
 * resolves its rows as objects keyed by column name.
 *
 * - `postgresql`: the SQL text uses `$1`, `$2`, and so on, like postgres.js `sql.unsafe(text, params)`.
 * - `sqlite`: the SQL text uses `?`, like libSQL `client.execute({ sql, args })`. The store runs a statement that fails
 *   with `SQLITE_BUSY` again. Across several processes, use Postgres, remote libSQL, or `node:sqlite`. A local libSQL
 *   `file:` client is for one process only: after `SQLITE_BUSY` it can lose writes that it reported as done.
 */
export interface LeaseSqlClient {
  dialect: "postgresql" | "sqlite"
  query(sql: string, params: LeaseSqlParam[]): Promise<readonly Record<string, unknown>[]>
}

/** How long a SQLite statement retries while another connection holds the write lock. */
const busyRetryMs = 5_000

/**
 * Runs a SQLite statement again while it fails with `SQLITE_BUSY`, which SQLite allows for a statement outside a
 * transaction. It waits without blocking the event loop, unlike `PRAGMA busy_timeout` on a synchronous client.
 */
async function retryBusy<T>(run: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + busyRetryMs
  for (let delay = 2; ; delay = Math.min(delay * 2, 50)) {
    try {
      return await run()
    }
    catch (error) {
      if (!isBusy(error) || Date.now() + delay > deadline) throw error
      await new Promise(resolve => setTimeout(resolve, delay * (0.5 + Math.random())))
    }
  }
}

/** libSQL and better-sqlite3 set `code` to `SQLITE_BUSY`. Other drivers only say so in the message. */
function isBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code: unknown = Reflect.get(error, "code")
  return (typeof code === "string" && code.startsWith("SQLITE_BUSY")) || /SQLITE_BUSY|database is locked/i.test(error.message)
}

/** The parameter values that the lease statements pass. */
export type LeaseSqlParam = string | number | null

/** The table of `createSqlLeaseStore()`. The store creates it when it is missing. */
export const leaseTable = "vitehub_leases"

/**
 * Leases in a SQL table, shared by every process that uses the same Database. Each operation is one statement, so
 * two processes that acquire a key at the same time get one winner. Expiry uses the clock of the Database, not the
 * clocks of the hosts. Works on Postgres and on SQLite 3.35 or later, such as libSQL.
 */
export function createSqlLeaseStore(client: LeaseSqlClient): LeaseStore {
  const now = client.dialect === "postgresql"
    ? "(extract(epoch from clock_timestamp()) * 1000)::bigint"
    : "cast((julianday('now') - 2440587.5) * 86400000 as integer)"
  /** Runs SQL written with `?` placeholders, which become `$1`, `$2`, ... on Postgres. */
  const query = (sql: string, params: LeaseSqlParam[]) => {
    if (client.dialect === "sqlite") return retryBusy(() => client.query(sql, params))
    let index = 0
    return client.query(sql.replace(/\?/g, () => `$${++index}`), params)
  }
  const table = leaseTable
  const columns = `("key" text primary key, id text not null, owner text, expires_at bigint not null)`
  const index = `create index if not exists ${table}_expires_at on ${table} (expires_at)`
  // Postgres sessions that create the same missing table or index at once can fail on its catalog, so one statement
  // takes a transaction lock first. SQLite runs DDL under its write lock already.
  const create = client.dialect === "postgresql"
    ? [`do $$ begin perform pg_advisory_xact_lock(hashtext('${table}')); create table if not exists ${table} ${columns}; ${index}; end $$`]
    : [`create table if not exists ${table} ${columns}`, index]

  let ready: Promise<void> | undefined
  let sweptAt = 0
  function ensureTable(): Promise<void> {
    ready ??= (async () => {
      try {
        // A table that exists needs no DDL. Postgres prints a notice for each `if not exists` that skips.
        await query(`select 1 from ${table} limit 0`, [])
        return
      }
      catch {}
      for (const statement of create) await query(statement, [])
    })()
    ready.catch(() => {
      ready = undefined
    })
    return ready
  }
  const end = (value: unknown) => Number(value)

  return createLeaseStore({
    async acquire(key, id, owner, ttlMs) {
      await ensureTable()
      if (Date.now() - sweptAt >= sweepIntervalMs) {
        sweptAt = Date.now()
        await query(`delete from ${table} where expires_at <= ${now}`, [])
      }
      // One statement: a free key inserts, an expired lease is replaced, and a live lease returns no row. A run again
      // after SQLITE_BUSY finds its own ID when the first run committed, and gets its lease back.
      // Compute the conflict expiry after locking the row: Postgres evaluates the proposed insert before the wait.
      const [row] = await query(
        `insert into ${table} ("key", id, owner, expires_at) values (?, ?, ?, ${now} + cast(? as bigint))
         on conflict ("key") do update set id = excluded.id, owner = excluded.owner, expires_at = ${now} + cast(? as bigint)
         where ${table}.expires_at <= ${now} or ${table}.id = excluded.id
         returning id, expires_at`,
        [key, id, owner ?? null, ttlMs, ttlMs],
      )
      return row?.id === id ? end(row.expires_at) : undefined
    },
    async renew(key, id, ttlMs) {
      await ensureTable()
      // Postgres can project an UPDATE's expiry before waiting on its row lock. FOR UPDATE keeps the CTE from
      // being inlined and locks the matching holder before the outer UPDATE evaluates the Database clock.
      const [row] = client.dialect === "postgresql"
        ? await query(
            `with held as (select "key", id from ${table} where "key" = ? and id = ? for update)
             update ${table} set expires_at = ${now} + cast(? as bigint) from held
             where ${table}."key" = held."key" and ${table}.id = held.id returning ${table}.expires_at`,
            [key, id, ttlMs],
          )
        : await query(`update ${table} set expires_at = ${now} + cast(? as bigint) where "key" = ? and id = ? returning expires_at`, [ttlMs, key, id])
      return row ? end(row.expires_at) : undefined
    },
    async release(key, id) {
      await ensureTable()
      const rows = await query(`delete from ${table} where "key" = ? and id = ? returning id`, [key, id])
      return rows.length > 0
    },
    async get(key) {
      await ensureTable()
      const [row] = await query(`select id, owner, expires_at from ${table} where "key" = ? and expires_at > ${now}`, [key])
      if (!row) return undefined
      return { id: String(row.id), ...(typeof row.owner === "string" ? { owner: row.owner } : {}), expiresAt: end(row.expires_at) }
    },
  })
}
