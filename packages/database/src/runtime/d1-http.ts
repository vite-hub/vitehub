import { drizzle as drizzleProxy } from "drizzle-orm/sqlite-proxy"

import { resolveConfigValue } from "../config-value.ts"
import { databaseErrorDiagnostics } from "../error-diagnostics.ts"

import type { RuntimeDrizzleDatabase, RuntimeDrizzleDatabaseConfig } from "../types.ts"

interface D1HttpQuery {
  params: unknown[]
  sql: string
}

type D1HttpMethod = "run" | "all" | "values" | "get"

type D1HttpExecutionQuery = D1HttpQuery & { method: D1HttpMethod }

interface D1HttpPayload {
  errors?: D1HttpErrorInfo[]
  result?: Array<{
    error?: string
    errors?: D1HttpErrorInfo[]
    results?: unknown
    success?: boolean
  }>
  success?: boolean
}

type D1HttpResult = NonNullable<D1HttpPayload["result"]>[number]

interface D1HttpErrorInfo {
  message?: string
}

interface D1HttpErrorSource {
  error?: string
  errors?: D1HttpErrorInfo[]
}

function getD1HttpErrorDetail(...sources: Array<D1HttpErrorSource | undefined>) {
  const messages = sources.flatMap(source => [
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- D1 JSON error fields are untrusted; only strings can enter diagnostics.
    ...(typeof source?.error === "string" ? [source.error] : []),
    ...(Array.isArray(source?.errors) ? source.errors : [])
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- D1 JSON error messages are untrusted; only strings can enter diagnostics.
      .map(error => typeof error?.message === "string" ? error.message : undefined),
  ]).filter((message): message is string => Boolean(message?.trim()))
  return messages.join("; ")
}

function cloudflareD1HttpError(response: Response, label = "request", ...sources: Array<D1HttpErrorSource | undefined>) {
  const detail = getD1HttpErrorDetail(...sources)
  return databaseErrorDiagnostics.DATABASE_R0007({ message: `[vitehub] Cloudflare D1 ${label} failed (${response.status})${detail ? `: ${detail}` : "."}` })
}

function validateD1HttpUrl(value: string, name: string) {
  try {
    const url = new URL(value)
    if (url.protocol === "http:" || url.protocol === "https:") return value
  }
  catch {}
  throw databaseErrorDiagnostics.DATABASE_R0008({ message: `[vitehub] Cloudflare D1 database "${name}" requires cloudflare.http.url to be an HTTP(S) URL.` })
}

function isD1HttpPayload(value: unknown): value is D1HttpPayload {
  if (!isRecord(value)) return false
  const result = "result" in value ? value.result : undefined
  return result === undefined
    || (Array.isArray(result) && result.every(isD1HttpResult))
}

function isD1HttpResult(value: unknown): value is D1HttpResult {
  return isRecord(value) && (value.success === true || value.success === false)
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
      throw databaseErrorDiagnostics.DATABASE_R0009({ message: `[vitehub] Cloudflare D1 database "${config.name}" requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN when cloudflare.http is true.` })
    }
    return {
      token,
      url: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/raw`,
    }
  }

  const token = resolveConfigValue(http.authToken)?.trim()
  const url = resolveConfigValue(http.url)?.trim()
  if (!token || !url) {
    throw databaseErrorDiagnostics.DATABASE_R0010({ message: `[vitehub] Cloudflare D1 database "${config.name}" requires cloudflare.http.url and cloudflare.http.authToken at runtime.` })
  }
  return { token, url: validateD1HttpUrl(url, config.name) }
}

function createCloudflareD1HttpDb<TSchema extends Record<string, unknown>>(
  config: { casing?: "snake_case" | "camelCase", token: string, url: string },
  schema: TSchema,
  request: typeof fetch,
) {
  async function execute(queries: D1HttpExecutionQuery[]) {
    const requestQueries = queries.map(({ params, sql }) => ({ params, sql }))
    const response = await request(config.url, {
      body: JSON.stringify(requestQueries.length === 1 ? requestQueries[0] : { batch: requestQueries }),
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    })

    let payload: D1HttpPayload
    try {
      const value: unknown = await response.json()
      if (!isD1HttpPayload(value)) throw databaseErrorDiagnostics.DATABASE_R0011({ message: "Invalid D1 response" })
      payload = value
    }
    catch {
      throw cloudflareD1HttpError(response)
    }

    if (!response.ok || payload.success !== true || !Array.isArray(payload.result)) {
      throw cloudflareD1HttpError(response, "request", payload)
    }
    if (payload.result.length !== queries.length) {
      throw databaseErrorDiagnostics.DATABASE_R0012({ message: "[vitehub] Cloudflare D1 returned an unexpected query result count." })
    }

    return payload.result.map((result, index) => {
      const query = queries[index]!
      if (result.success !== true) {
        throw cloudflareD1HttpError(response, `query ${index + 1}`, result, payload)
      }
      if (query.method === "run" && result.results === undefined) return []
      if (!isRecord(result.results)) {
        throw cloudflareD1HttpError(response, `query ${index + 1}`, result, payload)
      }
      if (!("rows" in result.results) || result.results.rows === undefined) {
        if (query.method === "run") return []
        throw cloudflareD1HttpError(response, `query ${index + 1}`, result, payload)
      }
      if (!isRowMatrix(result.results.rows)) {
        throw cloudflareD1HttpError(response, `query ${index + 1}`, result, payload)
      }
      return result.results.rows
    })
  }

  function formatResult(rows: unknown[][], method: "run" | "all" | "values" | "get") {
    // SAFETY: sqlite-proxy returns one row with the get method, and its row type is unknown[].
    return { rows: method === "get" ? rows[0] as unknown[] : rows }
  }

  // SAFETY: drizzleProxy returns the runtime database interface for the supplied schema.
  return drizzleProxy(
    async (sql, params, method) => formatResult((await execute([{ method, params, sql }]))[0]!, method),
    async queries => (await execute(queries.map(({ method, params, sql }) => ({ method, params, sql }))))
      .map((rows, index) => formatResult(rows, queries[index]!.method)),
    { casing: config.casing, schema },
  ) as RuntimeDrizzleDatabase<TSchema>
}

/** Resolves current credentials and shares the matching D1 HTTP Drizzle database. */
export function createCloudflareD1HttpResolver<TSchema extends Record<string, unknown>>(
  config: RuntimeDrizzleDatabaseConfig,
  schema: TSchema,
  request: typeof fetch = (...args) => fetch(...args),
): () => RuntimeDrizzleDatabase<TSchema> {
  let cached: { database: RuntimeDrizzleDatabase<TSchema>, token: string, url: string } | undefined
  return () => {
    const databaseId = resolveConfigValue(config.cloudflare?.databaseId)?.trim()
    if (!databaseId) {
      throw databaseErrorDiagnostics.DATABASE_R0013({ message: `[vitehub] Cloudflare D1 database "${config.name}" requires cloudflare.databaseId when cloudflare.http is configured.` })
    }
    const connection = resolveCloudflareD1HttpConnection(config, databaseId)!
    if (cached?.url === connection.url && cached.token === connection.token) return cached.database
    const database = createCloudflareD1HttpDb({ casing: config.drizzle.casing, ...connection }, schema, request)
    cached = { database, ...connection }
    return database
  }
}
