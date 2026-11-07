import virtualSchema from "#vitehub/database/schema"

import { databaseErrorDiagnostics } from "../error-diagnostics.ts"
import { createAgentDatabase } from "./agent.ts"
import { getRuntimeDatabases } from "./drizzle-runtime.ts"

import type { DatabaseDialect, RuntimeDrizzleDatabase, RuntimePostgresDatabase } from "../types.ts"

type DrizzleRuntimeDatabase<TSchema extends Record<string, unknown>, TDialect extends DatabaseDialect = "sqlite"> = TDialect extends "postgresql"
  ? RuntimePostgresDatabase<TSchema>
  : RuntimeDrizzleDatabase<TSchema>

export interface RuntimeDatabaseEntry<TSchema extends Record<string, unknown>, TDialect extends DatabaseDialect = "sqlite"> {
  db: DrizzleRuntimeDatabase<TSchema, TDialect>
  schema: TSchema
}

/** The Databases of the app. ViteHub generates this registry from the Database Definitions. */
export interface DatabaseRegistry {}

type RegisteredDatabaseSchema<Name extends keyof DatabaseRegistry> = DatabaseRegistry[Name] extends {
  schema: infer TSchema extends Record<string, unknown>
} ? TSchema : never

type RegisteredDatabaseDialect<Name extends keyof DatabaseRegistry> = DatabaseRegistry[Name] extends {
  dialect: infer TDialect extends DatabaseDialect
} ? TDialect : "sqlite"

type RuntimeDatabaseRegistry = {
  [Name in keyof DatabaseRegistry]: RuntimeDatabaseEntry<RegisteredDatabaseSchema<Name>, RegisteredDatabaseDialect<Name>>
}

type DefaultDatabaseEntry = RuntimeDatabaseRegistry extends { default: infer TEntry }
  ? TEntry
  : RuntimeDatabaseEntry<typeof virtualSchema>

type RuntimeDatabaseLookup = RuntimeDatabaseRegistry & {
  default: DefaultDatabaseEntry
} & Record<string, RuntimeDatabaseEntry<Record<string, unknown>>>

/**
 * An object that forwards every read to `resolve()`. Database Definitions import this module, and the generated
 * registry imports the Definitions, so the registry must not be read while the modules load.
 */
function deferred<T extends object>(resolve: () => T, bindMethods = false): T {
  // SAFETY: Every trap forwards to the resolved object, so the proxy behaves as that object.
  return new Proxy({} as T, {
    get: (_, property) => {
      const target = resolve()
      const value: unknown = Reflect.get(target, property, target)
      // A Drizzle method reads its own instance through `this`.
      return bindMethods && typeof value === "function" ? value.bind(target) : value
    },
    getOwnPropertyDescriptor: (_, property) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(resolve(), property)
      return descriptor && { ...descriptor, configurable: true }
    },
    has: (_, property) => Reflect.has(resolve(), property),
    ownKeys: () => Reflect.ownKeys(resolve()),
  })
}

// SAFETY: generated registry declarations specialize the runtime database lookup by name.
export const databases = deferred(() => getRuntimeDatabases().databases) as RuntimeDatabaseLookup

/** The default Database, as a Drizzle database. Each query connects on first use. */
// SAFETY: generated schema declarations specialize the default runtime database schema.
export const db = deferred(() => getRuntimeDatabases().databases.default.db, true) as DefaultDatabaseEntry["db"]

/**
 * The schema of the default Database.
 *
 * The generated registry types the default database, and the virtual schema is that database's schema. The package
 * resolves `#vitehub/database/schema` through its own `imports` field, so an app cannot augment that module for this
 * file. The registry is the one type source.
 */
// SAFETY: the generated registry gives the schema type of the default database.
export const schema = deferred(() => virtualSchema) as DefaultDatabaseEntry["schema"]

/** Returns the Drizzle database and schema of a Database Definition. An unknown name throws `DATABASE_NOT_FOUND`; `"default"` always resolves. */
export function useDatabase<Name extends keyof RuntimeDatabaseRegistry>(name: Name): RuntimeDatabaseRegistry[Name] {
  const runtime = getRuntimeDatabases()
  // The default entry always exists. Its `db` throws when the app has no Default Database.
  if (name !== "default" && !runtime.configured.has(name)) throw databaseErrorDiagnostics.DATABASE_NOT_FOUND({ database: String(name) })
  // SAFETY: the generated registry types each configured name with its schema and dialect.
  return runtime.databases[name] as RuntimeDatabaseRegistry[Name]
}

/** The Database Agent Capability handle. Generated Agent routes pass it to the Capability. */
export const agentDb = createAgentDatabase(databases)
