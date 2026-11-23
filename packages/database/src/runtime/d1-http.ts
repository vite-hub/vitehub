import { drizzle as drizzleProxy } from "drizzle-orm/sqlite-proxy"

import { assertD1Statement } from "./d1-limits.ts"
import { keepOwnClient, trackDatabaseCall } from "./request-stats.ts"
import { createSqlProxyExecutors, sqliteProxyCodecs, toSqlRow } from "./sqlite-proxy.ts"

import { resolveConfigValue } from "../config-value.ts"
import { databaseErrorDiagnostics } from "../error-diagnostics.ts"
import { createD1QueryAt, defaultD1MigrationsTable } from "../internal/d1-ledger.ts"

import type { AnyRelations } from "drizzle-orm"
import type { D1Query } from "../internal/d1-ledger.ts"
import type { RuntimeDrizzleDatabase, RuntimeDrizzleDatabaseConfig } from "../types.ts"
import type { SqlQuery, SqlResult } from "./sqlite-proxy.ts"

interface D1HttpPayload {
  errors?: D1HttpErrorInfo[]
  result?: Array<{
    error?: string
    errors?: D1HttpErrorInfo[]
    results?: { columns?: string[], rows?: unknown[][] }
    success?: boolean
  }>
  success?: boolean
}

interface D1HttpErrorInfo {
  message?: string
}

interface D1HttpErrorSource {
  error?: string
  errors?: D1HttpErrorInfo[]
}

const d1HttpRequestTimeoutMs = 30_000

function getD1HttpErrorDetail(...sources: Array<D1HttpErrorSource | undefined>) {
  const messages = sources.flatMap(source => [
    ...(typeof source?.error === "string" ? [source.error] : []),
    ...(Array.isArray(source?.errors) ? source.errors : [])
      .map(error => typeof error?.message === "string" ? error.message : undefined),
  ]).filter((message): message is string => Boolean(message?.trim()))
  return messages.join("; ")
}

function cloudflareD1HttpError(response: Response, label = "request", ...sources: Array<D1HttpErrorSource | undefined>) {
  const detail = getD1HttpErrorDetail(...sources)
  return databaseErrorDiagnostics.DATABASE_D1_REQUEST_FAILED({ detail: detail || undefined, label, status: response.status })
}

function validateD1HttpUrl(value: string, name: string) {
  try {
    const url = new URL(value)
    if (url.protocol === "http:" || url.protocol === "https:") return value
  }
  catch {}
  throw databaseErrorDiagnostics.DATABASE_INVALID_D1_HTTP_URL({ database: name })
}

function isD1HttpPayload(value: unknown): value is D1HttpPayload {
  if (!isRecord(value)) return false
  const result = "result" in value ? value.result : undefined
  return result === undefined
    || (Array.isArray(result) && result.every(item => isRecord(item)))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]"
}

function isRowMatrix(value: unknown): value is unknown[][] {
  return Array.isArray(value) && value.every(row => Array.isArray(row))
}

function resolveCloudflareD1HttpConnection(config: RuntimeDrizzleDatabaseConfig, databaseId: string) {
  const http = config.cloudflare?.http
  if (!http) return

  if (http === true) {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim()
    const token = process.env.CLOUDFLARE_API_TOKEN?.trim()
    if (!accountId || !token) {
      throw databaseErrorDiagnostics.DATABASE_MISSING_D1_HTTP_CONFIG({ database: config.name, missing: "the `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` environment variables" })
    }
    const database = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}`
    return { queryUrl: `${database}/query`, token, url: `${database}/raw` }
  }

  const token = resolveConfigValue(http.authToken)?.trim()
  const url = resolveConfigValue(http.url)?.trim()
  if (!token || !url) {
    throw databaseErrorDiagnostics.DATABASE_MISSING_D1_HTTP_CONFIG({ database: config.name, missing: "`cloudflare.http.url` and `cloudflare.http.authToken`" })
  }
  const valid = validateD1HttpUrl(url, config.name)
  return { queryUrl: valid, token, url: valid }
}

/**
 * `db.$client` of a D1 HTTP database. `query` sends SQL that can hold several statements, as one D1 batch, and returns
 * the rows of the last statement. Migrations on start use it.
 */
export interface D1HttpClient {
  migrationsTable: string
  protocol: "d1-http"
  query: D1Query
  target: string
}

function migrationTarget(endpoint: string): string {
  const url = new URL(endpoint)
  url.hash = ""
  if (url.origin === "https://api.cloudflare.com") url.pathname = url.pathname.replace(/\/(?:raw|query)$/, "")
  return url.href
}

/** A Drizzle database that sends each query to a D1 `/raw` endpoint or a proxy with the same protocol. */
export function createCloudflareD1HttpDb<TSchema extends Record<string, unknown>, TRelations extends AnyRelations>(
  config: { token: string, url: string },
  relations: TRelations,
  request: typeof fetch,
) {
  async function execute(queries: SqlQuery[]): Promise<SqlResult[]> {
    if (!queries.length) return []
    for (const { params, sql } of queries) assertD1Statement(sql, params)
    const requestQueries = queries.map(({ params, sql }) => ({ params, sql }))
    const response = await trackDatabaseCall(() => request(config.url, {
      body: JSON.stringify(requestQueries.length === 1 ? requestQueries[0] : { batch: requestQueries }),
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(d1HttpRequestTimeoutMs),
    }))

    let value: unknown
    try {
      value = await response.json()
    }
    catch {
      throw cloudflareD1HttpError(response)
    }
    if (!isD1HttpPayload(value)) throw databaseErrorDiagnostics.DATABASE_D1_INVALID_RESPONSE()
    const payload = value

    if (!response.ok || payload.success !== true || !Array.isArray(payload.result)) {
      throw cloudflareD1HttpError(response, "request", payload)
    }
    if (payload.result.length !== queries.length) {
      throw databaseErrorDiagnostics.DATABASE_D1_INVALID_RESPONSE()
    }

    return payload.result.map((result, index) => {
      const query = queries[index]!
      if (result.success !== true) {
        throw cloudflareD1HttpError(response, `query ${index + 1}`, result, payload)
      }
      if (query.method === "run" && result.results === undefined) return []
      if (!isRecord(result.results)) throw cloudflareD1HttpError(response, `query ${index + 1}`, result, payload)
      if (!("rows" in result.results) || result.results.rows === undefined) {
        if (query.method === "run") return []
        throw cloudflareD1HttpError(response, `query ${index + 1}`, result, payload)
      }
      if (!isRowMatrix(result.results.rows)) {
        throw databaseErrorDiagnostics.DATABASE_D1_INVALID_RESPONSE()
      }
      if (query.method === "run") return result.results.rows
      const columns = result.results.columns
      if (query.rowMode === "object" && !(Array.isArray(columns) && columns.every(column => typeof column === "string"))) {
        throw databaseErrorDiagnostics.DATABASE_D1_INVALID_RESPONSE()
      }
      const rows = query.rowMode === "object" ? result.results.rows.map(row => toSqlRow(columns ?? [], row, "object")) : result.results.rows
      return query.method === "get" ? rows[0] : rows
    })
  }

  const executors = createSqlProxyExecutors(async query => (await execute([query]))[0], execute)
  // SAFETY: drizzleProxy returns the runtime database interface for the relations of the schema.
  return drizzleProxy(executors, { codecs: sqliteProxyCodecs, relations }) as RuntimeDrizzleDatabase<TSchema, TRelations>
}

/** Resolves current credentials and shares the matching D1 HTTP Drizzle database. */
export function createCloudflareD1HttpResolver<TSchema extends Record<string, unknown>, TRelations extends AnyRelations>(
  config: RuntimeDrizzleDatabaseConfig,
  relations: TRelations,
  request: typeof fetch = (...args) => fetch(...args),
): () => RuntimeDrizzleDatabase<TSchema, TRelations> {
  let cached: { database: RuntimeDrizzleDatabase<TSchema, TRelations>, token: string, url: string } | undefined
  const requestWithDeadline: typeof fetch = (input, init) => request(input, { ...init, signal: AbortSignal.timeout(d1HttpRequestTimeoutMs) })
  return () => {
    const databaseId = resolveConfigValue(config.cloudflare?.databaseId)?.trim()
    if (!databaseId) {
      throw databaseErrorDiagnostics.DATABASE_MISSING_D1_HTTP_CONFIG({ database: config.name, missing: "`cloudflare.databaseId`" })
    }
    const { queryUrl, token, url } = resolveCloudflareD1HttpConnection(config, databaseId)!
    if (cached?.url === url && cached.token === token) return cached.database
    const client: D1HttpClient = {
      migrationsTable: config.cloudflare?.migrationsTable ?? defaultD1MigrationsTable,
      protocol: "d1-http",
      query: createD1QueryAt(queryUrl, token, problem => databaseErrorDiagnostics.DATABASE_D1_MIGRATION_FAILED({ database: config.name, problem }), requestWithDeadline),
      target: migrationTarget(queryUrl),
    }
    const database = keepOwnClient(createCloudflareD1HttpDb<TSchema, TRelations>({ token, url }, relations, request), client)
    cached = { database, token, url }
    return database
  }
}
