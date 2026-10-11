import { getActiveCloudflareBinding } from "@vite-hub/internal/runtime/cloudflare-env"
import { drizzle as drizzleD1 } from "drizzle-orm/d1"

import { resolveConfigValue } from "../config-value.ts"
import { createCloudflareD1HttpResolver } from "./d1-http.ts"

import type { RuntimeDrizzleDatabase, RuntimeDrizzleDatabaseConfig } from "../types.ts"
import { databaseErrorDiagnostics } from "../error-diagnostics.ts"

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
  createClient: (options: { authToken?: string, url: string }) => LibsqlClient
  drizzle: (config: { casing?: "snake_case" | "camelCase", client: unknown, schema: Record<string, unknown> }) => unknown
}

interface LibsqlClient {
  close?: () => void
}

interface DrizzleSqliteAdapterOptions {
  libsql?: LibsqlClientFactory
  requireRemoteUrl: boolean
  resolveLocalUrl?: (url: string) => string
  missingConnectionMessage: (config: RuntimeDrizzleDatabaseConfig) => string
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
  const getD1HttpDb = createCloudflareD1HttpResolver(config, schema)
  let libsqlInstance: RuntimeDrizzleDatabase<TSchema> | undefined
  let libsqlInstanceToken: string | undefined
  let libsqlInstanceUrl: string | undefined
  let libsqlClient: LibsqlClient | undefined

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

    if (config.cloudflare?.http) return getD1HttpDb()

    const url = resolveConfigValue(config.connection?.url)
    if (!url || !options.libsql || (options.requireRemoteUrl && !isRemoteSqliteUrl(url))) {
      throw databaseErrorDiagnostics.DATABASE_R0014({ message: options.missingConnectionMessage(config) })
    }

    const authToken = resolveConfigValue(config.connection?.authToken)
    if (libsqlInstance && libsqlInstanceUrl === url && libsqlInstanceToken === authToken) {
      return libsqlInstance
    }

    const client = options.libsql.createClient({
      authToken,
      url: options.resolveLocalUrl ? options.resolveLocalUrl(url) : url,
    })
    let instance: RuntimeDrizzleDatabase<TSchema>
    try {
      // SAFETY: The injected libSQL adapters expose the same Drizzle database contract as the runtime schema generic.
      instance = options.libsql.drizzle({
        casing: config.drizzle.casing,
        client,
        schema,
      }) as RuntimeDrizzleDatabase<TSchema>
    }
    catch (error) {
      client.close?.()
      throw error
    }

    // Refreshing credentials is an explicit lifecycle boundary: close the superseded
    // client after the replacement is ready. Callers must await database work before
    // changing the credential because libSQL close() aborts operations still in flight.
    libsqlClient?.close?.()
    libsqlClient = client
    libsqlInstance = instance
    libsqlInstanceToken = authToken
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
