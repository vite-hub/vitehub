import { getActiveCloudflareBinding } from "@vite-hub/internal/runtime/cloudflare-env"
import { drizzle as drizzleD1 } from "drizzle-orm/d1"

import { resolveConfigValue } from "../config-value.ts"
import { createCloudflareD1HttpResolver } from "./d1-http.ts"
import { checkD1Limits, checkLibsqlD1Limits } from "./d1-limits.ts"
import { useD1Session } from "./d1-sessions.ts"
import { keepOwnClient, trackD1Database, trackLibsqlClient } from "./request-stats.ts"
import { postgresConnectionUrl } from "./postgres-connection.ts"

import type { Client } from "@libsql/client"
import type { AnyRelations } from "drizzle-orm"
import type { RuntimeDrizzleDatabase, RuntimeDrizzleDatabaseConfig, SchemaRelations } from "../types.ts"
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
  withSession?: (constraint: string) => D1DatabaseLike & { getBookmark: () => string | null }
}

export interface LibsqlClientFactory {
  createClient: (options: { authToken?: string, url: string }) => Client
  /** Builds Drizzle's libSQL database on the client, as `createLibsqlDrizzle()` does. It must import no libSQL client. */
  drizzle: (client: Client, config: { relations: AnyRelations }) => unknown
}

/**
 * libSQL for a local SQLite database, from `#vitehub/database/libsql`. A Cloudflare build without a remote libSQL URL
 * resolves that import to `undefined`, so the Worker ships no libSQL client.
 */
export interface LocalSqlite extends LibsqlClientFactory {
  /** The in-memory database of app tests. See `createTestDatabaseClient()`. */
  createTestClient: (root: string, migrationsDir: string) => Client
  resolveLocalUrl: (url: string) => string
}

interface DrizzleSqliteAdapterOptions {
  libsql?: LibsqlClientFactory
  requireRemoteUrl: boolean
  resolveLocalUrl?: (url: string) => string
  /** What the database needs, for the `why` of `DATABASE_MISSING_CONNECTION`. */
  missingConnection: string
}

export function isRemoteSqliteUrl(url: string) {
  return /^(?:libsql:|https?:\/\/)/i.test(url)
}

/** `relations` holds every table of the schema, so `db.query.<table>` reads each one. */
export function createDrizzleSqliteAdapter<TSchema extends Record<string, unknown>, TRelations extends AnyRelations = SchemaRelations<TSchema>>(
  config: RuntimeDrizzleDatabaseConfig,
  relations: TRelations,
  options: DrizzleSqliteAdapterOptions,
) {
  // By binding, or by D1 session with read replication.
  const d1Instances = new WeakMap<D1DatabaseLike, RuntimeDrizzleDatabase<TSchema, TRelations>>()
  const getD1HttpDb = createCloudflareD1HttpResolver(config, relations)
  let libsqlInstance: RuntimeDrizzleDatabase<TSchema, TRelations> | undefined
  let libsqlInstanceToken: string | undefined
  let libsqlInstanceUrl: string | undefined
  let libsqlClient: Client | undefined
  let remoteNoticeShown = false

  function getDb() {
    if (config.remote) {
      if (!remoteNoticeShown) {
        remoteNoticeShown = true
        const databaseId = resolveConfigValue(config.cloudflare?.databaseId)?.trim()
        console.warn(`[vitehub] Database "${config.name}" is remote: \`vite dev\` queries the real D1 database${databaseId ? ` ${databaseId}` : ""} over HTTP. Writes change real data.`)
      }
      return getD1HttpDb()
    }

    const bindingName = config.cloudflare?.binding
    const d1Binding = bindingName
      ? getActiveCloudflareBinding<D1DatabaseLike>(bindingName)
      : undefined

    if (d1Binding) {
      const client = (config.cloudflare?.readReplication && bindingName ? useD1Session(bindingName, d1Binding) : undefined) ?? d1Binding
      const cached = d1Instances.get(client)
      if (cached) {
        return cached
      }

      const instance = keepOwnClient(drizzleD1(checkD1Limits(trackD1Database(client)), { relations }), client) as RuntimeDrizzleDatabase<TSchema, TRelations>
      d1Instances.set(client, instance)
      return instance
    }

    if (config.cloudflare?.http) return getD1HttpDb()

    const url = resolveConfigValue(config.connection?.url)
    if (!url || !options.libsql || (options.requireRemoteUrl && !isRemoteSqliteUrl(url))) {
      throw databaseErrorDiagnostics.DATABASE_MISSING_CONNECTION({ database: config.name, needs: options.missingConnection })
    }

    const authToken = resolveConfigValue(config.connection?.authToken)
    if (libsqlInstance && libsqlInstanceUrl === url && libsqlInstanceToken === authToken) {
      return libsqlInstance
    }

    const client = options.libsql.createClient({
      authToken,
      url: options.resolveLocalUrl ? options.resolveLocalUrl(url) : url,
    })
    let instance: RuntimeDrizzleDatabase<TSchema, TRelations>
    try {
      // SAFETY: The injected libSQL adapters expose the same Drizzle database contract as the runtime schema generic.
      // Local SQLite stands in for the D1 binding in a dev server for Cloudflare, so it rejects what D1 rejects.
      instance = keepOwnClient(Object(options.libsql.drizzle(
        trackLibsqlClient(config.cloudflare && config.localLimits === "d1" ? checkLibsqlD1Limits(client) : client),
        { relations },
      )), client) as RuntimeDrizzleDatabase<TSchema, TRelations>
    }
    catch (error) {
      client.close()
      throw error
    }

    // Refreshing credentials is an explicit lifecycle boundary: close the superseded
    // client after the replacement is ready. Callers must await database work before
    // changing the credential because libSQL close() aborts operations still in flight.
    libsqlClient?.close()
    libsqlClient = client
    libsqlInstance = instance
    libsqlInstanceToken = authToken
    libsqlInstanceUrl = url

    return libsqlInstance
  }

  return new Proxy({} as RuntimeDrizzleDatabase<TSchema, TRelations>, {
    get(_, prop) {
      if (prop === postgresConnectionUrl) return undefined
      const instance = getDb()
      const value = instance[prop as keyof RuntimeDrizzleDatabase<TSchema, TRelations>]
      return typeof value === "function" ? value.bind(instance) : value
    },
    // Drizzle's `is()` reads the prototype, so `is(db, SQLiteAsyncDatabase)` sees the live database.
    getPrototypeOf: () => Object.getPrototypeOf(getDb()),
  }) as RuntimeDrizzleDatabase<TSchema, TRelations>
}
