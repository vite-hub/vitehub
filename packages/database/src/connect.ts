import { createClient } from "@libsql/client/http"
import { getActiveCloudflareBinding } from "@vite-hub/internal/runtime/cloudflare-env"
import { drizzle } from "drizzle-orm/sqlite-proxy"

import { parseDatabaseLocation, postgresSchemes } from "./database-location.ts"
import { databaseErrorDiagnostics } from "./error-diagnostics.ts"

import type { InValue } from "@libsql/client/http"
import type { SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy"
import type { DatabaseLocation } from "./database-location.ts"

export { parseDatabaseLocation } from "./database-location.ts"
export type { DatabaseLocation } from "./database-location.ts"

export type SqlMethod = "run" | "all" | "values" | "get"

export interface SqlQuery {
  sql: string
  params: unknown[]
  method: SqlMethod
}

/**
 * Runs SQL for `connectDatabase()`. Rows are arrays of column values; `get` returns one row, or an empty array. A batch
 * is one transaction.
 */
export interface SqlDriver {
  query(query: SqlQuery): Promise<unknown[]>
  batch(queries: SqlQuery[]): Promise<unknown[][]>
}

export interface ConnectDatabaseOptions<TSchema extends Record<string, unknown>> {
  /** The Drizzle tables, for `db.query`. */
  schema?: TSchema
  /**
   * Statements that create the tables, such as `CREATE TABLE IF NOT EXISTS`. They run once for each database before its
   * first query, and again on the next query when they fail.
   */
  setup?: readonly string[]
  /** Where to connect when `where` finds no database, such as a SQLite file on the development server. */
  fallback?: string
  /** Names the database in errors. Default `"default"`. */
  name?: string
  /** Opens SQLite files. `@vite-hub/database/connect/node` sets it; Workers have no files. */
  openFile?: (path: string) => SqlDriver
}

/** What a location points to at runtime, with what was read to find it. */
type Connection =
  | { kind: "d1", binding: string, database: D1Binding }
  | { kind: "url", url: string, authToken?: string }
  | { kind: "file", path: string }

/** The environment variables and binding that `connectDatabase()` reads when it gets no location. */
export const defaultDatabaseLocations = { urls: ["DATABASE_URL", "TURSO_DATABASE_URL"], d1: "DB" } as const

/** The variable that holds the token of a URL variable: `TURSO_DATABASE_URL` → `TURSO_AUTH_TOKEN`, `DB_URL` → `DB_AUTH_TOKEN`. */
export function authTokenVariable(urlVariable: string): string {
  const name = urlVariable.replace(/(?:_DATABASE)?_URL$/, "_AUTH_TOKEN")
  return name === urlVariable ? `${urlVariable}_AUTH_TOKEN` : name
}

/** A server variable: a Worker binding or `process.env`. */
function serverEnv(name: string): string | undefined {
  const value: unknown = getActiveCloudflareBinding<unknown>(name) ?? globalThis.process?.env?.[name]
  return typeof value === "string" && value ? value : undefined
}

interface D1Statement {
  bind(...values: unknown[]): D1Statement
  run(): Promise<unknown>
  raw(): Promise<unknown[][]>
}

interface D1Binding {
  prepare(query: string): D1Statement
  batch(statements: D1Statement[]): Promise<Array<{ results?: unknown[] }>>
}

function d1Binding(name: string): D1Binding | undefined {
  const value: unknown = getActiveCloudflareBinding<unknown>(name)
  const isD1 = value !== null && typeof value === "object" && typeof Reflect.get(value, "prepare") === "function" && typeof Reflect.get(value, "batch") === "function"
  // SAFETY: a binding with D1's `prepare` and `batch` is a D1 database.
  return isD1 ? value as D1Binding : undefined
}

let warnedPostgres = false

/** The connection of a URL read from `from`. A Postgres URL is unsupported, except where `skipPostgres` skips it. */
function urlConnection(url: string, authToken: string | undefined, name: string, skipPostgres: boolean): Connection | undefined {
  if (postgresSchemes.test(url)) {
    if (!skipPostgres) throw databaseErrorDiagnostics.DATABASE_UNSUPPORTED_URL({ database: name, value: "a Postgres URL" })
    if (!warnedPostgres) console.warn(`[vitehub] The database "${name}" skips DATABASE_URL, because it is a Postgres URL, and looks further.`)
    warnedPostgres = true
    return
  }
  if (url.startsWith("file:")) return { kind: "file", path: url.slice(5) }
  // A token in the URL wins, as in the libSQL client.
  return { kind: "url", url, ...(authToken && !/[?&]authToken=/.test(url) ? { authToken } : {}) }
}

/** The connection that a location points to now, or undefined when its binding or variable is missing. */
function find(location: DatabaseLocation, name: string): Connection | undefined {
  switch (location.kind) {
    case "d1": {
      const database = d1Binding(location.binding)
      return database ? { kind: "d1", binding: location.binding, database } : undefined
    }
    case "env": {
      const url = serverEnv(location.name)
      return url ? urlConnection(url, serverEnv(authTokenVariable(location.name)), name, false) : undefined
    }
    case "url":
      return urlConnection(location.url, undefined, name, false)
    case "file":
      return { kind: "file", path: location.path }
    case "auto": {
      for (const variable of defaultDatabaseLocations.urls) {
        const url = serverEnv(variable)
        const connection = url ? urlConnection(url, serverEnv(authTokenVariable(variable)), name, true) : undefined
        if (connection) return connection
      }
      const database = d1Binding(defaultDatabaseLocations.d1)
      return database ? { kind: "d1", binding: defaultDatabaseLocations.d1, database } : undefined
    }
  }
}

function describe(location: DatabaseLocation): string {
  switch (location.kind) {
    case "d1": return `the Cloudflare D1 binding "${location.binding}"`
    case "env": return `the environment variable ${location.name}`
    case "url": return "a libSQL URL"
    case "file": return "a SQLite file"
    case "auto": return `${defaultDatabaseLocations.urls.join(" or ")}, or the Cloudflare D1 binding "${defaultDatabaseLocations.d1}"`
  }
}

function d1Driver(d1: D1Binding): SqlDriver {
  return {
    async query({ sql, params, method }) {
      const statement = d1.prepare(sql).bind(...params)
      if (method === "run") {
        await statement.run()
        return []
      }
      const rows = await statement.raw()
      return method === "get" ? rows[0] ?? [] : rows
    },
    async batch(queries) {
      const results = await d1.batch(queries.map(({ sql, params }) => d1.prepare(sql).bind(...params)))
      // D1 returns batch rows as objects; Drizzle reads arrays of column values, as its D1 driver does.
      return results.map((result, index) => queries[index]!.method === "run"
        ? []
        : (result.results ?? []).map(row => row !== null && typeof row === "object" ? Object.values(row) : []))
    },
  }
}

function libsqlDriver(url: string, authToken: string | undefined): SqlDriver {
  const client = createClient({ url, ...(authToken ? { authToken } : {}) })
  const rowsOf = (result: { columns: string[], rows: ArrayLike<unknown>[] }, method: SqlMethod): unknown[] => {
    if (method === "run") return []
    const rows = result.rows.map(row => Array.from({ length: result.columns.length }, (_, index) => row[index]))
    return method === "get" ? rows[0] ?? [] : rows
  }
  // SAFETY: Drizzle binds only SQLite values: text, numbers, blobs, and null.
  const statement = ({ sql, params }: SqlQuery) => ({ sql, args: params as InValue[] })
  return {
    query: async query => rowsOf(await client.execute(statement(query)), query.method),
    batch: async queries => (await client.batch(queries.map(statement), "write")).map((result, index) => rowsOf(result, queries[index]!.method)),
  }
}

/**
 * A Drizzle SQLite database at `where`: a D1 binding, a libSQL URL in an environment variable, a libSQL URL, or a SQLite
 * file. See `parseDatabaseLocation()`. It finds the database on each query, because a Worker has its bindings only during
 * a request, and runs `setup` once before the first query of each database. On Workers, import it from
 * `@vite-hub/database/connect`; on Node, from `@vite-hub/database/connect/node`, which opens files too.
 */
export function connectDatabase<TSchema extends Record<string, unknown> = Record<string, never>>(where: string | undefined, options: ConnectDatabaseOptions<TSchema> = {}): SqliteRemoteDatabase<TSchema> {
  const name = options.name ?? "default"
  const location = parseDatabaseLocation(where, name)
  const fallback = options.fallback === undefined ? undefined : parseDatabaseLocation(options.fallback, name)
  const byBinding = new WeakMap<D1Binding, SqlDriver>()
  const byKey = new Map<string, SqlDriver>()
  const ready = new WeakMap<SqlDriver, Promise<unknown>>()

  function open(connection: Connection): SqlDriver {
    if (connection.kind === "d1") {
      let driver = byBinding.get(connection.database)
      if (!driver) byBinding.set(connection.database, driver = d1Driver(connection.database))
      return driver
    }
    const key = connection.kind === "file" ? `file\0${connection.path}` : `url\0${connection.url}\0${connection.authToken ?? ""}`
    let driver = byKey.get(key)
    if (!driver) {
      if (connection.kind === "file") {
        if (!options.openFile) throw databaseErrorDiagnostics.DATABASE_UNSUPPORTED_URL({ database: name, value: "a SQLite file on this runtime" })
        driver = options.openFile(connection.path)
      }
      else driver = libsqlDriver(connection.url, connection.authToken)
      // A URL that changes, such as a rotated token, replaces the client.
      if (byKey.size > 8) byKey.clear()
      byKey.set(key, driver)
    }
    return driver
  }

  async function current(): Promise<SqlDriver> {
    const connection = find(location, name) ?? (fallback ? find(fallback, name) : undefined)
    if (!connection) throw databaseErrorDiagnostics.DATABASE_NOT_CONNECTED({ database: name, looked: describe(location) })
    const driver = open(connection)
    if (options.setup?.length) {
      let setup = ready.get(driver)
      if (!setup) {
        setup = driver.batch(options.setup.map(sql => ({ sql, params: [], method: "run" })))
        setup.catch(() => ready.delete(driver))
        ready.set(driver, setup)
      }
      await setup
    }
    return driver
  }

  return drizzle<TSchema>(
    async (sql, params, method) => ({ rows: await (await current()).query({ sql, params, method }) }),
    async queries => (await (await current()).batch(queries)).map(rows => ({ rows })),
    options.schema ? { schema: options.schema } : {},
  )
}
