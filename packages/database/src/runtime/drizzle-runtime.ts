import databaseEntries from "#vitehub/database/databases"
import { createConfiguredDatabase } from "#vitehub/database/definition-runtime"

import type { AnyRelations } from "drizzle-orm"
import type { ResolvedDrizzleDatabaseConfig, RuntimeDrizzleDatabase } from "../types.ts"
import { databaseErrorDiagnostics } from "../error-diagnostics.ts"
import { fallbackDatabasesMarker, sharedRuntimeKey } from "./shared-runtime.ts"
import { shareRuntimeDatabases } from "./use-database.ts"

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

  return createConfiguredDatabase(config, relations, config.migrationsDir)
}

function resolveDatabases() {
  const runtimeEntries = databaseEntries as unknown as Record<string, RuntimeDatabaseModule>
  // SAFETY: Each generated entry has a database and schema; the default entry is added below.
  const resolved = Object.fromEntries(
    Object.entries(runtimeEntries).map(([name, entry]) => [
      name,
      {
        db: entry.db ?? createRuntimeDatabase(entry.config, entry.relations, name),
        relations: entry.relations,
        schema: entry.schema,
      } satisfies RuntimeDatabaseEntry<Record<string, unknown>>,
    ]),
  ) as Record<string, RuntimeDatabaseEntry<Record<string, unknown>>>
  return {
    configured: new Set(Object.keys(runtimeEntries)),
    databases: {
      ...resolved,
      default: resolved.default ?? { db: createMissingDatabaseProxy("default"), relations: {}, schema: {} },
    } as Record<string, RuntimeDatabaseEntry<Record<string, unknown>>> & { default: RuntimeDatabaseEntry<Record<string, unknown>> },
  }
}

let runtimeDatabases: ReturnType<typeof resolveDatabases> | undefined

const isFallback = Object.hasOwn(databaseEntries, fallbackDatabasesMarker)
if (!isFallback) shareRuntimeDatabases(getRuntimeDatabases)

/**
 * The runtime databases, resolved on first use. Database Definitions import this package, and the generated registry
 * imports the Definitions, so the module must not read the registry while it loads.
 */
export function getRuntimeDatabases(): ReturnType<typeof resolveDatabases> {
  const shared: unknown = isFallback ? Reflect.get(globalThis, sharedRuntimeKey) : undefined
  // SAFETY: Only a copy of this module sets the shared key, to its own getRuntimeDatabases().
  if (typeof shared === "function") return (shared as typeof getRuntimeDatabases)()
  return runtimeDatabases ??= resolveDatabases()
}
