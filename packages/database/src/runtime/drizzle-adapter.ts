import { getActiveCloudflareBinding } from "@vite-hub/internal/runtime/cloudflare-env"
import { drizzle as drizzleD1 } from "drizzle-orm/d1"
import { drizzle as drizzleProxy } from "drizzle-orm/sqlite-proxy"

import { resolveConfigValue } from "../config-value.ts"

import type { RuntimeDrizzleDatabase, RuntimeDrizzleDatabaseConfig } from "../types.ts"

interface D1PreparedStatement {
  bind: (...params: unknown[]) => {
    all: () => Promise<{ results: Record<string, unknown>[] }>
    raw: () => Promise<unknown[][]>
    run: () => Promise<unknown>
  }
}

interface D1DatabaseLike {
  batch: (statements: unknown[]) => Promise<Array<{ results: Record<string, unknown>[] }>>
  prepare: (query: string) => D1PreparedStatement
}

interface LibsqlClientFactory {
  createClient: (options: { authToken?: string, url: string }) => unknown
  drizzle: (config: { casing?: "snake_case" | "camelCase", client: unknown, schema: Record<string, unknown> }) => unknown
}

interface DrizzleSqliteAdapterOptions {
  libsql: LibsqlClientFactory
  requireRemoteUrl: boolean
  resolveLocalUrl?: (url: string) => string
  missingConnectionMessage: (config: RuntimeDrizzleDatabaseConfig) => string
}

interface D1HttpQuery {
  params: unknown[]
  sql: string
}

interface D1HttpPayload {
  errors?: D1HttpErrorInfo[]
  result?: Array<{
    error?: unknown
    errors?: D1HttpErrorInfo[]
    results?: { rows?: unknown[][] }
    success?: boolean
  }>
  success?: boolean
}

interface D1HttpErrorInfo {
  message?: unknown
}

interface D1HttpErrorSource {
  error?: unknown
  errors?: D1HttpErrorInfo[]
}

function getD1HttpErrorDetail(...sources: Array<D1HttpErrorSource | undefined>) {
  const messages = sources.flatMap(source => [
    ...(typeof source?.error === "string" ? [source.error] : []),
    ...(Array.isArray(source?.errors) ? source.errors : []).map(error => error.message),
  ]).filter((message): message is string => typeof message === "string" && Boolean(message.trim()))
  return messages.join("; ")
}

function cloudflareD1HttpError(response: Response, label = "request", ...sources: Array<D1HttpErrorSource | undefined>) {
  const detail = getD1HttpErrorDetail(...sources)
  return new Error(`[vitehub] Cloudflare D1 ${label} failed (${response.status})${detail ? `: ${detail}` : "."}`)
}

function validateD1HttpUrl(value: string, name: string) {
  try {
    const url = new URL(value)
    if (url.protocol === "http:" || url.protocol === "https:") return value
  }
  catch {}
  throw new Error(`[vitehub] Cloudflare D1 database "${name}" requires cloudflare.http.url to be an HTTP(S) URL.`)
}

function isD1HttpPayload(value: unknown): value is D1HttpPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const result = "result" in value ? value.result : undefined
  return typeof result === "undefined"
    || (Array.isArray(result) && result.every(item => Boolean(item) && typeof item === "object" && !Array.isArray(item)))
}

function resolveCloudflareD1HttpConnection(config: RuntimeDrizzleDatabaseConfig, databaseId: string) {
  const http = config.cloudflare?.http
  if (!http) return

  if (http === true) {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim()
    const token = process.env.CLOUDFLARE_API_TOKEN?.trim()
    if (!accountId || !token) {
      throw new Error(`[vitehub] Cloudflare D1 database "${config.name}" requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN when cloudflare.http is true.`)
    }
    return {
      token,
      url: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/raw`,
    }
  }

  const token = resolveConfigValue(http.authToken)?.trim()
  const url = resolveConfigValue(http.url)?.trim()
  if (!token || !url) {
    throw new Error(`[vitehub] Cloudflare D1 database "${config.name}" requires cloudflare.http.url and cloudflare.http.authToken at runtime.`)
  }
  return { token, url: validateD1HttpUrl(url, config.name) }
}

function createCloudflareD1HttpDb<TSchema extends Record<string, unknown>>(
  config: { casing?: "snake_case" | "camelCase", token: string, url: string },
  schema: TSchema,
) {
  async function execute(queries: D1HttpQuery[]) {
    const response = await fetch(config.url, {
      body: JSON.stringify(queries.length === 1 ? queries[0] : { batch: queries }),
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    })

    let payload: D1HttpPayload
    try {
      const value: unknown = await response.json()
      if (!isD1HttpPayload(value)) throw new TypeError("Invalid D1 response")
      payload = value
    }
    catch {
      throw cloudflareD1HttpError(response)
    }

    if (!response.ok || payload.success !== true || !Array.isArray(payload.result)) {
      throw cloudflareD1HttpError(response, "request", payload)
    }
    if (payload.result.length !== queries.length) {
      throw new Error("[vitehub] Cloudflare D1 returned an unexpected query result count.")
    }

    return payload.result.map((result, index) => {
      if (result.success !== true) {
        throw cloudflareD1HttpError(response, `query ${index + 1}`, result, payload)
      }
      return Array.isArray(result.results?.rows) ? result.results.rows : []
    })
  }

  function formatResult(rows: unknown[][], method: "run" | "all" | "values" | "get") {
    return { rows: method === "get" ? rows[0] as unknown[] : rows }
  }

  return drizzleProxy(
    async (sql, params, method) => formatResult((await execute([{ params, sql }]))[0]!, method),
    async queries => (await execute(queries.map(({ params, sql }) => ({ params, sql }))))
      .map((rows, index) => formatResult(rows, queries[index]!.method)),
    { casing: config.casing, schema },
  ) as RuntimeDrizzleDatabase<TSchema>
}

export function isRemoteSqliteUrl(url: string) {
  return /^(?:libsql:|https?:\/\/)/i.test(url)
}

export function createDrizzleSqliteAdapter<TSchema extends Record<string, unknown>>(
  config: RuntimeDrizzleDatabaseConfig,
  schema: TSchema,
  options: DrizzleSqliteAdapterOptions,
) {
  const d1Instances = new WeakMap<D1DatabaseLike, RuntimeDrizzleDatabase<TSchema>>()
  let d1HttpInstance: RuntimeDrizzleDatabase<TSchema> | undefined
  let d1HttpInstanceToken: string | undefined
  let d1HttpInstanceUrl: string | undefined
  let libsqlInstance: RuntimeDrizzleDatabase<TSchema> | undefined
  let libsqlInstanceUrl: string | undefined

  function getDb() {
    const bindingName = config.cloudflare?.binding
    const d1Binding = bindingName
      ? getActiveCloudflareBinding<D1DatabaseLike>(bindingName)
      : undefined

    if (d1Binding) {
      const cached = d1Instances.get(d1Binding)
      if (cached) {
        return cached
      }

      const instance = drizzleD1(d1Binding, {
        casing: config.drizzle.casing,
        schema,
      }) as RuntimeDrizzleDatabase<TSchema>
      d1Instances.set(d1Binding, instance)
      return instance
    }

    if (config.cloudflare?.http) {
      const databaseId = resolveConfigValue(config.cloudflare.databaseId)?.trim()
      if (!databaseId) {
        throw new Error(`[vitehub] Cloudflare D1 database "${config.name}" requires cloudflare.databaseId when cloudflare.http is configured.`)
      }
      const http = resolveCloudflareD1HttpConnection(config, databaseId)!
      if (d1HttpInstance && d1HttpInstanceUrl === http.url && d1HttpInstanceToken === http.token) {
        return d1HttpInstance
      }

      d1HttpInstance = createCloudflareD1HttpDb({
        casing: config.drizzle.casing,
        ...http,
      }, schema)
      d1HttpInstanceToken = http.token
      d1HttpInstanceUrl = http.url
      return d1HttpInstance
    }

    const url = resolveConfigValue(config.connection?.url)
    if (!url || (options.requireRemoteUrl && !isRemoteSqliteUrl(url))) {
      throw new Error(options.missingConnectionMessage(config))
    }

    if (libsqlInstance && libsqlInstanceUrl === url) {
      return libsqlInstance
    }

    libsqlInstance = options.libsql.drizzle({
      casing: config.drizzle.casing,
      client: options.libsql.createClient({
        authToken: resolveConfigValue(config.connection?.authToken),
        url: options.resolveLocalUrl ? options.resolveLocalUrl(url) : url,
      }),
      schema,
    }) as RuntimeDrizzleDatabase<TSchema>
    libsqlInstanceUrl = url

    return libsqlInstance
  }

  return new Proxy({} as RuntimeDrizzleDatabase<TSchema>, {
    get(_, prop) {
      const instance = getDb()
      const value = instance[prop as keyof RuntimeDrizzleDatabase<TSchema>]
      return typeof value === "function" ? value.bind(instance) : value
    },
  }) as RuntimeDrizzleDatabase<TSchema>
}
