import virtualSchema from "#vitehub/database/schema"
import { ensureDatabaseMigrations } from "./migrate-on-start.ts"
import { readPostgresConnectionUrl } from "./postgres-connection.ts"

import { createAgentDatabase, createDatabaseBindingLookup } from "./agent.ts"
import { getRuntimeDatabases } from "./drizzle-runtime.ts"
import { createUseDatabase } from "./use-database.ts"

import type { DatabaseD1Binding } from "./agent.ts"
import type { AnyRelations } from "drizzle-orm"
import type { DatabaseDialect, MergeDatabaseRelations, RuntimeDrizzleDatabase, RuntimePostgresDatabase, SchemaRelations } from "../types.ts"

type DrizzleRuntimeDatabase<TSchema extends Record<string, unknown>, TDialect extends DatabaseDialect, TRelations extends AnyRelations> = TDialect extends "postgresql"
  ? RuntimePostgresDatabase<TSchema, TRelations>
  : RuntimeDrizzleDatabase<TSchema, TRelations>

export interface RuntimeDatabaseEntry<
  TSchema extends Record<string, unknown>,
  TDialect extends DatabaseDialect = "sqlite",
  TRelations extends AnyRelations = SchemaRelations<TSchema>,
> {
  db: DrizzleRuntimeDatabase<TSchema, TDialect, TRelations>
  /** Every table of the schema, with the relations of the Definition, its Nuxt layers, and contributed tables. */
  relations: TRelations
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

/**
 * A registry entry sets `relations` to one relations object, or to a list of parts that merge like Nuxt layers, lowest
 * precedence first. The generated registry lists the parts of contributed tables and of each layer.
 */
type RegisteredDatabaseRelations<Name extends keyof DatabaseRegistry> = DatabaseRegistry[Name] extends { relations: infer TRelations }
  ? TRelations extends readonly unknown[]
    ? MergeDatabaseRelations<RegisteredDatabaseSchema<Name>, TRelations>
    : TRelations extends AnyRelations ? TRelations : SchemaRelations<RegisteredDatabaseSchema<Name>>
  : SchemaRelations<RegisteredDatabaseSchema<Name>>

type RuntimeDatabaseRegistry = {
  [Name in keyof DatabaseRegistry]: RuntimeDatabaseEntry<RegisteredDatabaseSchema<Name>, RegisteredDatabaseDialect<Name>, RegisteredDatabaseRelations<Name>>
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

type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never

/** The Database that `useDatabase()` returns without a name: `default`, else the only one. */
type DefaultDatabaseName = "default" extends keyof RuntimeDatabaseRegistry
  ? "default"
  : true extends IsUnion<keyof RuntimeDatabaseRegistry> ? never : keyof RuntimeDatabaseRegistry

/** Returns the default or only Database without a name; unknown or ambiguous names throw with the available choices. */
export function useDatabase<Name extends DefaultDatabaseName = DefaultDatabaseName>(
  ...name: [DefaultDatabaseName] extends [never] ? [name: never] : []
): RuntimeDatabaseRegistry[Name]
export function useDatabase<Name extends keyof RuntimeDatabaseRegistry>(name: Name): RuntimeDatabaseRegistry[Name]
export function useDatabase(name?: string): RuntimeDatabaseEntry<Record<string, unknown>> {
  const runtime = getRuntimeDatabases()
  return createUseDatabase(runtime.databases, [...runtime.configured])(name)
}

const lookupDatabaseBinding = createDatabaseBindingLookup(databases)

/**
 * Return the Cloudflare D1 binding of a Database, or the request's D1 session with read replication. Exposes the shared
 * prepare/batch API for consumers such as the D1 Agent Invocation store. Throws `DATABASE_NO_D1_BINDING` when the Database
 * does not run on a D1 binding here, and `DATABASE_NOT_FOUND` for an unknown name.
 */
export function useDatabaseBinding(name: "default" | keyof RuntimeDatabaseRegistry): DatabaseD1Binding {
  return lookupDatabaseBinding(name)
}

/** The Database Agent Capability handle. Generated Agent routes pass it to the Capability. */
export const agentDb = createAgentDatabase(databases)

/**
 * The connection URL of the Postgres Database `name`, as its client resolves it outside a request: the Hyperdrive
 * binding, then `connection.url`. It is `undefined` for a Database that is not Postgres, and for a Postgres Database
 * that connects through PG* environment variables. It throws `DATABASE_MISSING_CONNECTION` when a Postgres Database
 * has none of these. Use it in a package that opens its own Postgres client, so that it uses the same database.
 */
export function getPostgresConnectionUrl(name = "default"): string | undefined {
  return readPostgresConnectionUrl(databases, name)
}

/**
 * Applies the pending migrations of the Database `name`, or of every Database, once in this process. It runs the same
 * path as the server start: a Postgres database migrates under the advisory lock, so other processes apply nothing
 * twice. Parallel calls share one run, and the server start shares it too. A failed run is forgotten, so the next call
 * tries again.
 *
 * @example
 * await ensureMigrations()
 */
export function ensureMigrations(name?: keyof RuntimeDatabaseRegistry & string): Promise<void> {
  // A dynamic import keeps the migration SQL out of the server start until a call needs it.
  const load = () => import("#vitehub/database/migrations").then(module => module.default)
  return ensureDatabaseMigrations({ databases, load }, name === undefined ? undefined : [name])
}
