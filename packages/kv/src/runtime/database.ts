import type { KVListOptions, KVListPage, ResolvedDatabaseKVStoreConfig } from "../types.ts"
import type { KVRuntimeDriver } from "./driver.ts"
import { kvErrorDiagnostics } from "../error-diagnostics.ts"
import { chunks } from "./batch.ts"

/** The table that keeps the keys of every `database` store. Each store has its rows under its own `namespace`. */
export const kvTable = "vitehub_kv"

export type KVSqlParam = string | number | null

/**
 * Runs one statement and resolves its rows as objects keyed by column name. `postgresql` SQL uses `$1`, `$2`, ... and
 * `sqlite` SQL uses `?`.
 */
export interface KVSqlClient {
  dialect: "postgresql" | "sqlite"
  query(sql: string, params: KVSqlParam[]): Promise<readonly Record<string, unknown>[]>
}

/** The databases of the app, as `@vite-hub/database/runtime/registry` exports them. */
export type KVDatabases = Record<string, { db: object } | undefined>

interface PostgresClient {
  unsafe(sql: string, params: KVSqlParam[]): Promise<readonly Record<string, unknown>[]>
}

interface LibsqlClient {
  execute(statement: { sql: string, args: KVSqlParam[] }): Promise<{ rows: readonly Record<string, unknown>[] }>
}

function hasMethod(value: unknown, name: string): boolean {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return false
  return typeof Reflect.get(value, name) === "function"
}

/**
 * A SQL client over the Drizzle database of the app. It reads `$client` on each query, because a Postgres Database on
 * Cloudflare has a client per request.
 */
export function kvSqlClientFromDatabase(db: object, database: string): KVSqlClient {
  const client = (): unknown => Reflect.get(db, "$client")
  const first = client()
  const dialect = hasMethod(first, "unsafe") ? "postgresql" : hasMethod(first, "execute") ? "sqlite" : undefined
  if (!dialect) throw kvErrorDiagnostics.KV_DATABASE_UNAVAILABLE({ database, problem: "unsupported" })
  return {
    dialect,
    async query(sql, params) {
      // SAFETY: The dialect check above found the method that each branch calls.
      if (dialect === "postgresql") return await (client() as PostgresClient).unsafe(sql, params)
      // SAFETY: As above, a libSQL client has `execute()`.
      return (await (client() as LibsqlClient).execute({ sql, args: params })).rows
    },
  }
}

/** Once cleanup catches up, wait this long before checking for newly expired keys. */
const sweepIntervalMs = 60_000
const sweepBatchSize = 1000
/** Rows per batch statement. It keeps the parameters below SQLite's oldest limit of 999. */
const batchRows = 200

function ttlMilliseconds(ttl: number): number {
  if (!Number.isFinite(ttl) || ttl <= 0) throw kvErrorDiagnostics.KV_INVALID_TTL()
  const ms = Math.ceil(ttl * 1000)
  if (!Number.isSafeInteger(ms)) throw kvErrorDiagnostics.KV_INVALID_TTL()
  return ms
}

function decodeCursor(cursor: string | undefined): string | undefined {
  if (!cursor) return undefined
  try {
    const value: unknown = JSON.parse(decodeURIComponent(cursor))
    const after: unknown = typeof value === "object" && value !== null ? Reflect.get(value, "after") : undefined
    if (typeof after === "string") return after
  }
  catch {}
  throw kvErrorDiagnostics.KV_INVALID_CURSOR({ problem: "invalid" })
}

/**
 * KV in a table of the app's Database. Each atomic operation is one statement, so two servers that write one key at
 * the same time get one winner. Expiry uses the clock of the Database. Works on Postgres and on SQLite 3.35 or later,
 * such as libSQL.
 */
export default function createDatabaseKVDriver(options: ResolvedDatabaseKVStoreConfig, connect: () => Promise<KVSqlClient>): KVRuntimeDriver {
  const table = kvTable
  const namespace = options.namespace
  let pending: Promise<KVSqlClient> | undefined
  let sweptAt = 0
  let sweeping = false
  let sweepWarned = false

  async function ready(): Promise<KVSqlClient> {
    pending ??= (async () => {
      const client = await connect()
      const columns = `(namespace text not null, "key" text not null, value text not null, expires_at bigint, primary key (namespace, "key"))`
      const index = `create index if not exists ${table}_expires_at on ${table} (expires_at)`
      try {
        // A table that exists needs no DDL. Postgres prints a notice for each `if not exists` that skips.
        await client.query(`select 1 from ${table} limit 0`, [])
        return client
      }
      catch {}
      // Postgres sessions that create the same missing table at once can fail on its catalog, so one statement takes a
      // transaction lock first. SQLite runs DDL under its write lock already.
      if (client.dialect === "postgresql") {
        await client.query(`do $$ begin perform pg_advisory_xact_lock(hashtext('${table}')); create table if not exists ${table} ${columns}; ${index}; end $$`, [])
      }
      else {
        await client.query(`create table if not exists ${table} ${columns}`, [])
        await client.query(index, [])
      }
      return client
    })()
    pending.catch(() => {
      pending = undefined
    })
    return pending
  }

  /** Runs SQL written with `?` placeholders, which become `$1`, `$2`, ... on Postgres. `{now}` is the Database clock in ms. */
  async function query(sql: string, params: KVSqlParam[]): Promise<readonly Record<string, unknown>[]> {
    const client = await ready()
    const now = client.dialect === "postgresql"
      ? "(extract(epoch from statement_timestamp()) * 1000)::bigint"
      : "cast((julianday('now') - 2440587.5) * 86400000 as integer)"
    let index = 0
    const text = sql.replaceAll("{now}", now)
    return client.query(client.dialect === "postgresql" ? text.replace(/\?/g, () => `$${++index}`) : text, params)
  }

  const live = `(expires_at is null or expires_at > {now})`

  /**
   * Deletes expired rows of this namespace in background batches. A full batch lets the next write sweep again;
   * otherwise cleanup waits a minute. Reads already skip expired rows. A failed sweep, for example on a lock
   * timeout, does not fail the write that runs it. It warns once and runs again a minute later.
   */
  async function sweep(): Promise<void> {
    if (sweeping || Date.now() - sweptAt < sweepIntervalMs) return
    sweeping = true
    sweptAt = Date.now()
    try {
      const { dialect } = await ready()
      const lock = dialect === "postgresql" ? " for update skip locked" : ""
      const rows = await query(`delete from ${table} where (namespace, "key") in (
        select namespace, "key" from ${table} where namespace = ? and expires_at <= {now} limit ${sweepBatchSize}${lock}
      ) returning 1`, [namespace])
      if (rows.length === sweepBatchSize) sweptAt = 0
    }
    catch (error) {
      if (!sweepWarned) console.warn(`[vitehub] KV could not delete expired rows from ${table}. It tries again every minute.`, error)
      sweepWarned = true
    }
    finally {
      sweeping = false
    }
  }

  /** Matches keys that start with `prefix`. `substr()` counts characters on both dialects, unlike `LIKE` on SQLite, which ignores case. */
  function prefixFilter(prefix: string | undefined): [string, KVSqlParam[]] {
    if (!prefix) return ["", []]
    return [` and substr("key", 1, ?) = ?`, [[...prefix].length, prefix]]
  }

  async function keys(prefix: string | undefined): Promise<string[]> {
    const [filter, params] = prefixFilter(prefix)
    const rows = await query(`select "key" from ${table} where namespace = ? and ${live}${filter} order by "key"`, [namespace, ...params])
    return rows.map(row => String(row.key))
  }

  async function upsert(items: readonly { key: string, value: string }[], setOptions: { ttl?: unknown } | undefined): Promise<void> {
    void sweep()
    const ttl = setOptions?.ttl
    // Like other unstorage drivers, no TTL or 0 keeps the key.
    if (ttl !== undefined && ttl !== null && ttl !== 0 && typeof ttl !== "number") throw kvErrorDiagnostics.KV_INVALID_TTL()
    const ms = typeof ttl === "number" && ttl !== 0 ? ttlMilliseconds(ttl) : undefined
    const row = `(?, ?, ?, ${ms === undefined ? "null" : "{now} + cast(? as bigint)"})`
    for (const batch of chunks(items, batchRows)) {
      await query(
        `insert into ${table} (namespace, "key", value, expires_at) values ${batch.map(() => row).join(", ")}
         on conflict (namespace, "key") do update set value = excluded.value, expires_at = excluded.expires_at`,
        batch.flatMap(item => ms === undefined ? [namespace, item.key, item.value] : [namespace, item.key, item.value, ms]),
      )
    }
  }

  const driver: KVRuntimeDriver = {
    name: "vitehub-kv-database",
    options,
    async hasItem(key) {
      return (await query(`select 1 as found from ${table} where namespace = ? and "key" = ? and ${live}`, [namespace, key])).length > 0
    },
    async getItem(key) {
      const [row] = await query(`select value from ${table} where namespace = ? and "key" = ? and ${live}`, [namespace, key])
      return row ? String(row.value) : null
    },
    // One query per 200 keys.
    async getItems(items) {
      const values = new Map<string, string>()
      for (const batch of chunks([...new Set(items.map(item => item.key))], batchRows)) {
        const rows = await query(
          `select "key", value from ${table} where namespace = ? and "key" in (${batch.map(() => "?").join(", ")}) and ${live}`,
          [namespace, ...batch],
        )
        for (const row of rows) values.set(String(row.key), String(row.value))
      }
      return items.map(item => ({ key: item.key, value: values.get(item.key) ?? null }))
    },
    setItem: (key, value, setOptions?: { ttl?: unknown }) => upsert([{ key, value }], setOptions),
    // One statement per 200 entries. kv.setMany() passes each key once, as one statement cannot update a row twice.
    setItems: (items, setOptions?: { ttl?: unknown }) => upsert(items, setOptions),
    async removeItem(key) {
      await query(`delete from ${table} where namespace = ? and "key" = ?`, [namespace, key])
    },
    getKeys: base => keys(base),
    async clear(base) {
      const [filter, params] = prefixFilter(base)
      await query(`delete from ${table} where namespace = ?${filter}`, [namespace, ...params])
    },
    async listKeys({ cursor, limit, prefix }: KVListOptions): Promise<KVListPage> {
      const after = decodeCursor(cursor)
      const [filter, params] = prefixFilter(prefix)
      const rows = await query(
        `select "key" from ${table} where namespace = ? and ${live}${filter}${after === undefined ? "" : ` and "key" > ?`} order by "key" limit ?`,
        [namespace, ...params, ...after === undefined ? [] : [after], limit + 1],
      )
      const page = rows.slice(0, limit).map(row => String(row.key))
      if (rows.length <= limit) return { keys: page }
      return { keys: page, cursor: encodeURIComponent(JSON.stringify({ after: page.at(-1) })) }
    },
    async setIfAbsentItem(key, value, ttl) {
      void sweep()
      const ms = ttl === undefined ? undefined : ttlMilliseconds(ttl)
      // One statement: a missing key inserts, an expired key is replaced, and a live key returns no row.
      const rows = await query(
        `insert into ${table} (namespace, "key", value, expires_at) values (?, ?, ?, ${ms === undefined ? "null" : "{now} + cast(? as bigint)"})
         on conflict (namespace, "key") do update set value = excluded.value, expires_at = excluded.expires_at
         where ${table}.expires_at is not null and ${table}.expires_at <= {now}
         returning "key"`,
        ms === undefined ? [namespace, key, value] : [namespace, key, value, ms],
      )
      return rows.length > 0
    },
    // doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- This implements the caller-typed driver read, like getItem().
    async getAndDeleteItem<T = unknown>(key: string): Promise<T | null> {
      const [row] = await query(`delete from ${table} where namespace = ? and "key" = ? returning value, ${live} as live`, [namespace, key])
      // An expired key is deleted too, but it had no value. Postgres returns a boolean, SQLite 1 or 0.
      if (!row || !(row.live === true || Number(row.live) === 1)) return null
      // SAFETY: The KV runtime decodes the stored text into the caller's type, as it does for getItem().
      return String(row.value) as T
    },
    async incrementItem(key, ttl) {
      const ms = ttlMilliseconds(ttl)
      // Counters such as rate limit windows are often written only by `increment()`, so it deletes expired rows too.
      void sweep()
      const { dialect } = await ready()
      const value = `${table}.value`
      // A canonical integer of at most 16 digits: no sign other than "-", no leading zero, and small enough that the
      // cast to bigint cannot overflow. Postgres does not promise to short-circuit `or`, so every cast sits behind
      // this check in a `case`, and a value such as "hello" gives null instead of a cast error on both dialects.
      const integer = dialect === "postgresql"
        // `query()` turns each `?` into a placeholder, so the pattern writes `-{0,1}`.
        ? `${value} ~ '^(0|-{0,1}[1-9][0-9]{0,15})$'`
        : `(length(${value}) <= 17 and (${value} = '0' or (${value} glob '[1-9]*' and ${value} not glob '*[^0-9]*') or (${value} glob '-[1-9]*' and substr(${value}, 2) not glob '*[^0-9]*')))`
      const counter = `(case when ${integer} then cast(${value} as bigint) end)`
      const expired = `${table}.expires_at is not null and ${table}.expires_at <= {now}`
      // One statement: a missing or expired counter starts at 1 with the TTL, also when the expired value was not an
      // integer, and a live one keeps its expiry. A live value that is not an integer below the safe limit fails the
      // `where`, so the statement changes nothing.
      const rows = await query(
        `insert into ${table} (namespace, "key", value, expires_at) values (?, ?, '1', {now} + cast(? as bigint))
         on conflict (namespace, "key") do update set
           value = case when ${expired} then '1' else cast(${counter} + 1 as text) end,
           expires_at = case when ${expired} then excluded.expires_at else ${table}.expires_at end
         where (${expired}) or ${counter} between -9007199254740992 and 9007199254740990
         returning value`,
        [namespace, key, ms],
      )
      if (rows.length === 0) throw kvErrorDiagnostics.KV_INVALID_COUNTER()
      const counterValue = Number(rows[0]!.value)
      if (!Number.isSafeInteger(counterValue)) throw kvErrorDiagnostics.KV_PROVIDER_INVALID_RESPONSE({ problem: "The counter exceeds the JavaScript safe integer range." })
      return counterValue
    },
    async deleteIfEqualsItem(key, expected) {
      const rows = await query(`delete from ${table} where namespace = ? and "key" = ? and value = ? and ${live} returning "key"`, [namespace, key, expected])
      return rows.length > 0
    },
    async dispose() {
      // The Database owns the connection.
      pending = undefined
    },
  }
  return driver
}
