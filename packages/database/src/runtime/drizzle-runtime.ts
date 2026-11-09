import databaseEntries from "#vitehub/database/databases"

import { createDrizzleSqliteAdapter } from "./drizzle-adapter.ts"
import { localLibsql } from "./local-client.ts"
import { resolveLocalSqliteUrl } from "./local-url.ts"
import { createTestDatabaseClient } from "./test-database.ts"
import { getViteHubTestMode } from "@vite-hub/runtime/internal/test-mode"

import type { AnyRelations } from "drizzle-orm"
import type { ResolvedDrizzleDatabaseConfig, RuntimeDrizzleDatabase } from "../types.ts"
import { databaseErrorDiagnostics } from "../error-diagnostics.ts"

interface RuntimeDatabaseModule {
  config?: ResolvedDrizzleDatabaseConfig
  /** Generated Postgres entries create their database client directly. */
  db?: RuntimeDrizzleDatabase<Record<string, unknown>, AnyRelations>
  /** Every table of the merged schema, with the relations of the Definition, its Nuxt layers, and contributed tables. */
  relations: AnyRelations
  schema: Record<string, unknown>
}

interface RuntimeDatabaseEntry<TSchema extends Record<string, unknown>> {
  db: RuntimeDrizzleDatabase<TSchema, AnyRelations>
  relations: AnyRelations
  schema: TSchema
}

function createMissingDatabaseProxy<TSchema extends Record<string, unknown>>(name: string) {
  // SAFETY: This unavailable-database proxy throws on every property read; no incomplete database escapes through it.
  return new Proxy({} as RuntimeDrizzleDatabase<TSchema, AnyRelations>, {
    get() {
      throw name === "default"
        ? databaseErrorDiagnostics.DATABASE_DISABLED()
        : databaseErrorDiagnostics.DATABASE_NOT_FOUND({ database: name })
    },
  }) as RuntimeDrizzleDatabase<TSchema, AnyRelations>
}

function createRuntimeDatabase(
  config: ResolvedDrizzleDatabaseConfig | undefined,
  relations: AnyRelations,
  name: string,
) {
  if (!config) {
    return createMissingDatabaseProxy(name)
  }

  return createDrizzleSqliteAdapter<Record<string, unknown>, AnyRelations>(config, relations, {
    libsql: localLibsql,
    missingConnection: "a Cloudflare D1 binding or `connection.url`",
    requireRemoteUrl: false,
    resolveLocalUrl: resolveLocalSqliteUrl,
  })
}

/**
 * In app tests, `vite-hub/test` turns on test mode, and each database is an in-memory SQLite with the migrations of
 * its Definition, created again after each reset. The choice happens on each property read, because the app imports
 * `db` before the test turns test mode on.
 */
function withTestDatabase(
  name: string,
  relations: AnyRelations,
  migrationsDir: string | undefined,
  database: RuntimeDrizzleDatabase<Record<string, unknown>, AnyRelations>,
): RuntimeDrizzleDatabase<Record<string, unknown>, AnyRelations> {
  function current(): RuntimeDrizzleDatabase<Record<string, unknown>, AnyRelations> {
    const test = getViteHubTestMode()
    if (!test) return database
    return test.backend(`database:${name}`, () => {
      const directory = migrationsDir ?? (name === "default" ? "server/databases/migrations" : `server/databases/${name}/migrations`)
      const client = createTestDatabaseClient(test.root, directory)
      // SAFETY: Drizzle's libSQL database is the runtime type of every SQLite Definition.
      return localLibsql.drizzle(client, { relations }) as RuntimeDrizzleDatabase<Record<string, unknown>, AnyRelations>
    }, db => (Reflect.get(db, "$client") as { close: () => void }).close())
  }
  // SAFETY: Every read goes to the current database, so the proxy has the full database shape.
  return new Proxy({} as RuntimeDrizzleDatabase<Record<string, unknown>, AnyRelations>, {
    get: (_target, property) => Reflect.get(current(), property),
    getPrototypeOf: () => Object.getPrototypeOf(current()),
    has: (_target, property) => Reflect.has(current(), property),
  })
}

const runtimeEntries = databaseEntries as unknown as Record<string, RuntimeDatabaseModule>

// SAFETY: Each generated entry has a database and schema; the default entry is checked below.
const resolvedDatabases = Object.fromEntries(
  Object.entries(runtimeEntries).map(([name, entry]) => [
    name,
    {
      // Postgres entries bring their own client and keep it in tests.
      db: entry.db ?? (entry.config
        ? withTestDatabase(name, entry.relations, entry.config.migrationsDir, createRuntimeDatabase(entry.config, entry.relations, name))
        : createMissingDatabaseProxy(name)),
      relations: entry.relations,
      schema: entry.schema,
    } satisfies RuntimeDatabaseEntry<Record<string, unknown>>,
  ]),
) as Record<string, RuntimeDatabaseEntry<Record<string, unknown>>> & {
  default: RuntimeDatabaseEntry<Record<string, unknown>>
}

const defaultDatabaseEntry = resolvedDatabases.default || {
  db: createMissingDatabaseProxy("default"),
  relations: {},
  schema: {},
}

export const databases = {
  ...resolvedDatabases,
  default: defaultDatabaseEntry,
} as Record<string, RuntimeDatabaseEntry<Record<string, unknown>>> & {
  default: RuntimeDatabaseEntry<Record<string, unknown>>
}

export const db = databases.default.db
