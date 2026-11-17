import { sql } from "drizzle-orm"

import type { Result } from "@vite-hub/runtime"
import type { SQL } from "drizzle-orm"

import { databaseErrorDiagnostics } from "../error-diagnostics.ts"

export interface WithIdempotencyOptions {
  /** Seconds that the stored result answers a repeat. After that, the key is new again. Default `86400`, one day. */
  ttl?: number
  /**
   * Seconds that a running call holds the key. A repeat in that time gets `DATABASE_IDEMPOTENCY_IN_PROGRESS`. When a
   * call crashes before it finishes, the next call after `timeout` runs `fn` again. Default `300`, five minutes.
   */
  timeout?: number
  /** The Database that stores the keys. Default: the default or only Database. */
  database?: string
}

/** The codes that `withIdempotency()` returns. */
export type WithIdempotencyErrorCode = "DATABASE_IDEMPOTENCY_INVALID_OPTIONS" | "DATABASE_IDEMPOTENCY_IN_PROGRESS"

/** A Drizzle database: Postgres runs every statement with `execute()`, SQLite with `all()`. */
export type IdempotencyDatabase =
  | { execute(query: SQL): PromiseLike<unknown> }
  | { all(query: SQL): PromiseLike<unknown>, execute?: undefined }

const table = sql.raw("vitehub_idempotency_keys")
const defaultTtl = 86_400
const defaultTimeout = 300
/** Expired keys mean nothing, so a process deletes them at most once per this interval. */
const sweepInterval = 60_000

const ready = new WeakMap<object, Promise<void>>()
const swept = new WeakMap<object, number>()

async function query(db: IdempotencyDatabase, statement: SQL): Promise<Record<string, unknown>[]> {
  if (db.execute) {
    // postgres.js resolves the rows. node-postgres and PGlite resolve `{ rows }`.
    const result = await db.execute(statement)
    return (Array.isArray(result) ? result : (result as { rows: Record<string, unknown>[] }).rows)
  }
  return await db.all(statement) as Record<string, unknown>[]
}

function createTable(db: IdempotencyDatabase): Promise<void> {
  let promise = ready.get(db)
  if (!promise) {
    promise = (async () => {
      const expiresAt = db.execute ? sql.raw("BIGINT") : sql.raw("INTEGER")
      // `IF NOT EXISTS` does not serialize Postgres catalog writes. A losing creator retries after the winner commits.
      // Retry each statement separately: a caller can lose both the table race and the subsequent index race.
      const create = async (statement: SQL) => {
        await query(db, statement).catch(() => query(db, statement))
      }
      await create(sql`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY NOT NULL, claim TEXT, result TEXT, expires_at ${expiresAt} NOT NULL)`)
      await create(sql`CREATE INDEX IF NOT EXISTS vitehub_idempotency_keys_expires_at ON ${table} (expires_at)`)
    })()
    promise.catch(() => ready.delete(db))
    ready.set(db, promise)
  }
  return promise
}

/** Claims the key, or returns the row that holds it. The same claim ID makes a second try safe. */
async function claimKey(db: IdempotencyDatabase, key: string, claim: string, now: number, lockedUntil: number) {
  const expired = sql`${table}.expires_at <= ${now}`
  const statement = sql`INSERT INTO ${table} (id, claim, result, expires_at) VALUES (${key}, ${claim}, NULL, ${lockedUntil})
    ON CONFLICT (id) DO UPDATE SET
      claim = CASE WHEN ${expired} THEN excluded.claim ELSE ${table}.claim END,
      result = CASE WHEN ${expired} THEN NULL ELSE ${table}.result END,
      expires_at = CASE WHEN ${expired} THEN excluded.expires_at ELSE ${table}.expires_at END
    RETURNING claim, result`
  try {
    return (await query(db, statement))[0]
  }
  catch (error) {
    // A `vite-hub/test` reset gives the same Database object a new, empty backend, so the table can be gone. Create it
    // again and try once more; any other error fails the same way again.
    ready.delete(db)
    await createTable(db).catch(() => { throw error })
    return (await query(db, statement))[0]
  }
}

async function sweep(db: IdempotencyDatabase, now: number): Promise<void> {
  if (now - (swept.get(db) ?? 0) < sweepInterval) return
  swept.set(db, now)
  await query(db, sql`DELETE FROM ${table} WHERE expires_at <= ${now}`)
}

function invalidSeconds(value: number | undefined): boolean {
  return value !== undefined && !(Number.isFinite(value) && value > 0)
}

/**
 * Runs `fn` once for `key` on the Database `db`. The core of `withIdempotency()`, which passes the app's Database.
 *
 * One statement claims the key, or returns the row that holds it: the stored result, or the claim of a running call.
 * The claim is a new random ID for each call, so a call whose claim expired cannot overwrite the next call's result.
 */
export async function runIdempotent<T>(
  db: IdempotencyDatabase,
  key: string,
  fn: () => T | PromiseLike<T>,
  options: Omit<WithIdempotencyOptions, "database"> = {},
): Promise<Result<Awaited<T>, WithIdempotencyErrorCode>> {
  if (typeof key !== "string" || !key) return [databaseErrorDiagnostics.DATABASE_IDEMPOTENCY_INVALID_OPTIONS({ option: "key" }), undefined]
  if (invalidSeconds(options.ttl)) return [databaseErrorDiagnostics.DATABASE_IDEMPOTENCY_INVALID_OPTIONS({ option: "ttl" }), undefined]
  if (invalidSeconds(options.timeout)) return [databaseErrorDiagnostics.DATABASE_IDEMPOTENCY_INVALID_OPTIONS({ option: "timeout" }), undefined]
  const ttl = Math.ceil((options.ttl ?? defaultTtl) * 1000)
  const timeout = Math.ceil((options.timeout ?? defaultTimeout) * 1000)

  await createTable(db)
  const now = Date.now()
  const claim = crypto.randomUUID()
  const row = await claimKey(db, key, claim, now, now + timeout)
  await sweep(db, now)
  if (row?.claim === null) {
    // SAFETY: the stored text is the JSON of a result of `fn` for this key.
    return [undefined, (row.result === null ? undefined : JSON.parse(String(row.result))) as Awaited<T>]
  }
  if (row?.claim !== claim) return [databaseErrorDiagnostics.DATABASE_IDEMPOTENCY_IN_PROGRESS({ key }), undefined]

  let value: Awaited<T>
  let stored: string | null
  try {
    value = await fn()
    stored = value === undefined ? null : JSON.stringify(value)
  }
  catch (error) {
    // The key is free again, so a retry runs `fn` again. When the delete fails too, the claim ends after `timeout`.
    await query(db, sql`DELETE FROM ${table} WHERE id = ${key} AND claim = ${claim}`).catch(() => {})
    throw error
  }
  await query(db, sql`UPDATE ${table} SET claim = NULL, result = ${stored}, expires_at = ${Date.now() + ttl} WHERE id = ${key} AND claim = ${claim}`)
  return [undefined, value]
}
