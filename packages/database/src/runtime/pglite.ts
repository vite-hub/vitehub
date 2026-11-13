import { existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

import { getViteHubTestMode } from "@vite-hub/runtime/internal/test-mode"

import { resolveConfigValue } from "../config-value.ts"
import { databaseErrorDiagnostics } from "../error-diagnostics.ts"
import { runsOnPglite } from "./postgres-env.ts"
import { keepOwnClient, trackPgliteClient } from "./request-stats.ts"

import type { PGlite as PgliteClient } from "@electric-sql/pglite"
import type { AnyRelations } from "drizzle-orm"
import type { LocalPostgresDatabase, PostgresDatabaseDefaults } from "./postgres-database.ts"
import type { DatabaseConfigValue, PostgresDatabaseDefinition, RuntimePostgresDatabase } from "../types.ts"

export interface PgliteOptions {
  /** Absolute folder of the PGlite data. */
  dataDir: string
  /** Absolute migrations folder. App tests apply its migrations to an in-memory PGlite. */
  migrationsDir: string
}

/** Methods that wait for the migrations of an app test database. */
const queryMethods = new Set<PropertyKey>(["exec", "query", "sql", "transaction"])

// PGlite must open a folder only once per process. `vite dev` evaluates the databases module again after a Definition
// changes, so the open clients stay in the process and the new module uses them.
const folderClientsKey = Symbol.for("vitehub.database.pglite")
const runtimeGlobal = globalThis as typeof globalThis & Record<symbol, unknown>
const folderClients = (runtimeGlobal[folderClientsKey] ||= new Map<string, PgliteClient>()) as Map<string, PgliteClient>

/**
 * Loads PGlite for a Postgres Database in development, when it sets `driver: "pglite"` or has no `connection.url` and
 * no PG* variables. Returns `undefined` when it connects to a server, so an app with a server never loads PGlite. The
 * generated development module awaits it, because Drizzle needs the database before the first query.
 */
export async function loadPglite<TSchema extends Record<string, unknown>, TRelations extends AnyRelations>(
  definition: PostgresDatabaseDefinition<TSchema, TRelations>,
  url: DatabaseConfigValue | undefined,
  options: PgliteOptions,
): Promise<LocalPostgresDatabase<TSchema, TRelations> | undefined> {
  if (!runsOnPglite(definition.driver, resolveConfigValue(definition.connection?.url ?? url))) return
  const always = definition.driver === "pglite"

  let modules: [typeof import("@electric-sql/pglite"), typeof import("drizzle-orm/pglite"), typeof import("drizzle-orm/pglite/migrator")]
  try {
    modules = await Promise.all([import("@electric-sql/pglite"), import("drizzle-orm/pglite"), import("drizzle-orm/pglite/migrator")])
  }
  catch (error) {
    return {
      always,
      get() {
        throw databaseErrorDiagnostics.DATABASE_PGLITE_NOT_INSTALLED({ cause: error, database: definition.name, reason: always ? "driver" : "no-connection" })
      },
    }
  }
  const [{ PGlite }, { drizzle }, { migrate }] = modules
  // The same relations as the postgres.js client, so `db.query.<table>` works.
  const { relations } = definition

  // Drizzle's queries count in the request stats. `db.$client` stays the client that Drizzle got.
  function open(client: PgliteClient): RuntimePostgresDatabase<TSchema, TRelations> {
    return keepOwnClient(drizzle({ client: trackPgliteClient(client), relations }), client)
  }

  // In app tests, each reset gives an empty in-memory database with the migrations of the Definition.
  function openTestDatabase() {
    const client = new PGlite("memory://")
    // Drizzle reads the `<timestamp>_<name>/migration.sql` folders of Drizzle Kit 1.0.
    const ready = existsSync(options.migrationsDir)
      ? migrate(drizzle({ client }), { migrationsFolder: options.migrationsDir })
      : Promise.resolve()
    // A failed migration rejects each query. Without a query, it is not an unhandled rejection.
    ready.catch(() => {})
    // Drizzle gets the client with query methods that wait for the migrations. PGlite has private fields, so each
    // method runs on the client itself.
    const db = open(new Proxy(client, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target)
        if (typeof value !== "function") return value
        return queryMethods.has(property)
          ? async (...args: unknown[]) => { await ready; return Reflect.apply(value, target, args) }
          : value.bind(target)
      },
    }))
    return { client, db }
  }

  let folderDatabase: RuntimePostgresDatabase<TSchema, TRelations> | undefined
  return {
    always,
    get() {
      const test = getViteHubTestMode()
      if (test) return test.backend(`database:${definition.name}`, openTestDatabase, ({ client }) => client.close()).db
      if (!folderDatabase) {
        let client = folderClients.get(options.dataDir)
        if (!client || client.closed) {
          mkdirSync(dirname(options.dataDir), { recursive: true })
          client = new PGlite(options.dataDir)
          folderClients.set(options.dataDir, client)
          console.info(`[vitehub] Database "${definition.name}" runs on PGlite in ${options.dataDir}${always ? "" : ", because it has no `connection.url` or PG* variables"}.`)
        }
        folderDatabase = open(client)
      }
      return folderDatabase
    },
  }
}

/**
 * Creates the Drizzle client of a Postgres Database in development, with PGlite when it has no server. It loads only
 * the driver of the Definition, so an app with `driver: "node-postgres"` needs no postgres.js, and the reverse.
 */
export async function createDevPostgresDatabase<TSchema extends Record<string, unknown>, TRelations extends AnyRelations>(
  definition: PostgresDatabaseDefinition<TSchema, TRelations>,
  defaults: PostgresDatabaseDefaults,
  options: PgliteOptions,
): Promise<RuntimePostgresDatabase<TSchema, TRelations>> {
  const create = definition.driver === "node-postgres"
    ? (await import("./node-postgres.ts")).createNodePostgresDatabase
    : (await import("./postgres.ts")).createPostgresDatabase
  return create(definition, defaults, await loadPglite(definition, defaults.url, options))
}
