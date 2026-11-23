import { logFailure } from "@vite-hub/internal/runtime/request-log"
import { d1PrimaryClient } from "@vite-hub/internal/runtime/cloudflare-env"

import type { KVPageOptions, KVListPage, ResolvedDatabaseKVStoreConfig } from "../types.ts"
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
  /** The most values that one statement may bind, such as 100 on Cloudflare D1. */
  maxParameters?: number
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

interface D1Client {
  prepare(sql: string): { bind(...params: KVSqlParam[]): { all(): Promise<{ results: readonly Record<string, unknown>[] }> } }
}

interface D1HttpClient {
  query(sql: string, params: KVSqlParam[], mode: "write"): Promise<readonly unknown[]>
}

function isD1HttpClient(value: unknown): boolean {
  return typeof value === "object" && value !== null && Reflect.get(value, "protocol") === "d1-http" && hasMethod(value, "query")
}

function isRow(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function objectRows(rows: readonly unknown[]): readonly Record<string, unknown>[] {
  if (rows.every(isRow)) return rows
  throw kvErrorDiagnostics.KV_PROVIDER_INVALID_RESPONSE({ problem: "Cloudflare D1 returned rows without column names." })
}

const d1MaxParameters = 100

function hasMethod(value: unknown, name: string): boolean {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return false
  return typeof Reflect.get(value, name) === "function"
}

/**
 * A SQL client over the Drizzle database of the app: postgres.js, libSQL, primary Cloudflare D1, or D1 over HTTP. It resolves
 * the client on each query because the Database connection can belong to the request.
 */
export function kvSqlClientFromDatabase(db: object, database: string): KVSqlClient {
  const client = (): unknown => Reflect.get(db, d1PrimaryClient) ?? Reflect.get(db, "$client")
  const first = client()
  if (hasMethod(first, "unsafe")) {
    // SAFETY: The check above found `unsafe()`, the query method of postgres.js.
    return { dialect: "postgresql", query: async (sql, params) => await (client() as PostgresClient).unsafe(sql, params) }
  }
  if (hasMethod(first, "execute")) {
    // SAFETY: The check above found `execute()`, the query method of a libSQL client.
    return { dialect: "sqlite", query: async (sql, params) => (await (client() as LibsqlClient).execute({ sql, args: params })).rows }
  }
  if (hasMethod(first, "prepare") && hasMethod(first, "batch")) {
    return {
      dialect: "sqlite",
      maxParameters: d1MaxParameters,
      // SAFETY: The check above found `prepare()` and `batch()`, the methods of a D1 binding.
      query: async (sql, params) => (await (client() as D1Client).prepare(sql).bind(...params).all()).results,
    }
  }
  if (isD1HttpClient(first)) {
    return {
      dialect: "sqlite",
      maxParameters: d1MaxParameters,
      // SAFETY: The check above found the `d1-http` client of `@vite-hub/database`, whose `query()` returns the rows of the statement.
      query: async (sql, params) => objectRows(await (client() as D1HttpClient).query(sql, params, "write")),
    }
  }
  throw kvErrorDiagnostics.KV_DATABASE_UNAVAILABLE({ database, problem: "unsupported" })
}

const sweepIntervalMs = 60_000
const sweepBatchSize = 1000
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

type DatabaseKVDriver = KVRuntimeDriver & Required<Pick<KVRuntimeDriver, "getItems">>

/**
 * KV in a table of the app's Database. Each atomic operation is one statement, so two servers that write one key at
 * the same time get one winner. Expiry uses the clock of the Database. Works on Postgres and on SQLite 3.35 or later,
 * such as libSQL and Cloudflare D1. `table` defaults to `vitehub_kv`. A caller that passes another table keeps its rows
 * out of reach of every KV store.
 */
export default function createDatabaseKVDriver(options: ResolvedDatabaseKVStoreConfig, connect: () => Promise<KVSqlClient>, table: string = kvTable): DatabaseKVDriver {
  const namespace = options.namespace
  let pending: Promise<KVSqlClient> | undefined
  let sweptAt = 0
  let sweeping = false
  let sweepFailing = false

  async function ready(): Promise<KVSqlClient> {
    pending ??= (async () => {
      const client = await connect()
      const columns = `(namespace text not null, "key" text not null, value text not null, expires_at bigint, primary key (namespace, "key"))`
      const index = `create index if not exists ${table}_expires_at on ${table} (expires_at)`
      try {
        await client.query(`select 1 from ${table} limit 0`, [])
        return client
      }
      catch {}
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
      sweepFailing = false
      if (rows.length === sweepBatchSize) sweptAt = 0
    }
    catch (error) {
      if (!sweepFailing) {
        logFailure({ field: "kv", fields: { op: "expiry-sweep", driver: "database", namespace }, message: "KV could not delete expired rows", error }, () => {
          console.warn(`[vitehub] KV could not delete expired rows from ${table}. It tries again every minute.`, error)
        })
      }
      sweepFailing = true
    }
    finally {
      sweeping = false
    }
  }

  function prefixFilter(prefix: string | undefined): [string, KVSqlParam[]] {
    if (!prefix) return ["", []]
    return [` and substr("key", 1, ?) = ?`, [[...prefix].length, prefix]]
  }

  async function keys(prefix: string | undefined): Promise<string[]> {
    const [filter, params] = prefixFilter(prefix)
    const rows = await query(`select "key" from ${table} where namespace = ? and ${live}${filter} order by "key"`, [namespace, ...params])
    return rows.map(row => String(row.key))
  }

  async function rowsPerStatement(parametersPerRow: number, fixedParameters = 0): Promise<number> {
    const { maxParameters } = await ready()
    return maxParameters === undefined ? batchRows : Math.min(batchRows, Math.floor((maxParameters - fixedParameters) / parametersPerRow))
  }

  async function upsert(items: readonly { key: string, value: string }[], setOptions: { ttl?: unknown } | undefined): Promise<void> {
    void sweep()
    const ttl = setOptions?.ttl
    if (ttl !== undefined && ttl !== null && ttl !== 0 && typeof ttl !== "number") throw kvErrorDiagnostics.KV_INVALID_TTL()
    const ms = typeof ttl === "number" && ttl !== 0 ? ttlMilliseconds(ttl) : undefined
    const row = `(?, ?, ?, ${ms === undefined ? "null" : "{now} + cast(? as bigint)"})`
    for (const batch of chunks(items, await rowsPerStatement(ms === undefined ? 3 : 4))) {
      await query(
        `insert into ${table} (namespace, "key", value, expires_at) values ${batch.map(() => row).join(", ")}
         on conflict (namespace, "key") do update set value = excluded.value, expires_at = excluded.expires_at`,
        batch.flatMap(item => ms === undefined ? [namespace, item.key, item.value] : [namespace, item.key, item.value, ms]),
      )
    }
  }

  const driver: DatabaseKVDriver = {
    name: "vitehub-kv-database",
    options,
    async hasItem(key) {
      return (await query(`select 1 as found from ${table} where namespace = ? and "key" = ? and ${live}`, [namespace, key])).length > 0
    },
    async getItem(key) {
      const [row] = await query(`select value from ${table} where namespace = ? and "key" = ? and ${live}`, [namespace, key])
      return row ? String(row.value) : null
    },
    async getItems(items) {
      const values = new Map<string, string>()
      for (const batch of chunks([...new Set(items.map(item => item.key))], await rowsPerStatement(1, 1))) {
        const rows = await query(
          `select "key", value from ${table} where namespace = ? and "key" in (${batch.map(() => "?").join(", ")}) and ${live}`,
          [namespace, ...batch],
        )
        for (const row of rows) values.set(String(row.key), String(row.value))
      }
      return items.map(item => ({ key: item.key, value: values.get(item.key) ?? null }))
    },
    setItem: (key, value, setOptions?: { ttl?: unknown }) => upsert([{ key, value }], setOptions),
    setItems: (items, setOptions?: { ttl?: unknown }) => upsert(items, setOptions),
    async removeItem(key) {
      await query(`delete from ${table} where namespace = ? and "key" = ?`, [namespace, key])
    },
    getKeys: base => keys(base),
    async clear(base) {
      const [filter, params] = prefixFilter(base)
      await query(`delete from ${table} where namespace = ?${filter}`, [namespace, ...params])
    },
    async listKeys({ cursor, limit, prefix }: KVPageOptions): Promise<KVListPage> {
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
      if (!row || !(row.live === true || Number(row.live) === 1)) return null
      // SAFETY: The KV runtime decodes the stored text into the caller's type, as it does for getItem().
      return String(row.value) as T
    },
    async incrementItem(key, ttl) {
      const ms = ttlMilliseconds(ttl)
      void sweep()
      const { dialect } = await ready()
      const value = `${table}.value`
      const integer = dialect === "postgresql"
        ? `${value} ~ '^(0|-{0,1}[1-9][0-9]{0,15})$'`
        : `(length(${value}) <= 17 and (${value} = '0' or (${value} glob '[1-9]*' and ${value} not glob '*[^0-9]*') or (${value} glob '-[1-9]*' and substr(${value}, 2) not glob '*[^0-9]*')))`
      const counter = `(case when ${integer} then cast(${value} as bigint) end)`
      const expired = `${table}.expires_at is not null and ${table}.expires_at <= {now}`
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
      pending = undefined
    },
  }
  return driver
}
