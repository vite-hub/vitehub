import { getActiveCloudflareBinding } from "@vitehub/internal/runtime/cloudflare-env"
import { drizzle as drizzleD1 } from "drizzle-orm/d1"
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core"

import type { ResolvedDrizzleDatabaseConfig } from "../types.ts"

export interface D1PreparedStatement {
  bind: (...params: unknown[]) => {
    all: () => Promise<{ results: Record<string, unknown>[] }>
    raw: () => Promise<unknown[][]>
    run: () => Promise<unknown>
  }
}

export interface D1DatabaseLike {
  batch: (statements: unknown[]) => Promise<Array<{ results: Record<string, unknown>[] }>>
  prepare: (query: string) => D1PreparedStatement
}

export type RuntimeDrizzleDatabase<TSchema extends Record<string, unknown>> = BaseSQLiteDatabase<"async", unknown, TSchema>

interface LibsqlClientFactory {
  createClient: (options: { authToken?: string, url: string }) => unknown
  drizzle: (config: { casing?: "snake_case" | "camelCase", client: unknown, schema: Record<string, unknown> }) => unknown
}

export interface DrizzleSqliteAdapterOptions {
  libsql: LibsqlClientFactory
  requireRemoteUrl: boolean
  resolveLocalUrl?: (url: string) => string
  missingConnectionMessage: (config: ResolvedDrizzleDatabaseConfig) => string
}

export function isRemoteSqliteUrl(url: string) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^libsql:/i.test(url)
}

export function createDrizzleSqliteAdapter<TSchema extends Record<string, unknown>>(
  config: ResolvedDrizzleDatabaseConfig,
  schema: TSchema,
  options: DrizzleSqliteAdapterOptions,
) {
  const d1Instances = new WeakMap<D1DatabaseLike, RuntimeDrizzleDatabase<TSchema>>()
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

    const url = config.connection?.url
    if (!url || (options.requireRemoteUrl && !isRemoteSqliteUrl(url))) {
      throw new Error(options.missingConnectionMessage(config))
    }

    if (libsqlInstance && libsqlInstanceUrl === url) {
      return libsqlInstance
    }

    libsqlInstance = options.libsql.drizzle({
      casing: config.drizzle.casing,
      client: options.libsql.createClient({
        authToken: config.connection?.authToken,
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
