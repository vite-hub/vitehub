// `authDatabase()` connects Better Auth to a ViteHub Database. The Auth Vite plugin finds the call in the Auth
// Definition and adds the Better Auth tables to that Database, so `vitehub database generate` writes their migration.
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { databases } from "@vite-hub/database/runtime/registry"
import { getAuthTables } from "better-auth/db"
import { getTableColumns, is, isTable } from "drizzle-orm"
import { PgAsyncDatabase } from "drizzle-orm/pg-core"

import { authErrorDiagnostics } from "./error-diagnostics.ts"
import { assertAuthDatabaseIdStrategy, authDatabaseSchemaError } from "./database-options.ts"
import { assertAuthDatabaseNames } from "./database-schema-options.ts"

import type { BetterAuthOptions } from "better-auth"
import type { AuthAppDatabase } from "./types.ts"

export type { AuthAppDatabase } from "./types.ts"

/**
 * Compares the tables and fields that the options need, with the plugins and additional fields, against the Drizzle
 * tables of the Database, before the adapter opens it.
 */
function assertAuthDatabaseSchema(options: BetterAuthOptions, schema: Readonly<Record<string, unknown>>, database: string): void {
  const fix = "Call the plugin in `server/auth.ts` and write `additionalFields` inline there, so that the Auth Vite plugin adds the columns. Then run `vitehub database generate` and apply the migration"
  for (const [model, table] of Object.entries(getAuthTables(options))) {
    const drizzleTable = Object.hasOwn(schema, model) ? schema[model] : undefined
    if (!isTable(drizzleTable)) throw authDatabaseSchemaError(`the ${JSON.stringify(database)} Database has no \`${model}\` table. ${fix}`)
    const columns = getTableColumns(drizzleTable)
    for (const key of Object.keys(table.fields)) {
      if (!Object.hasOwn(columns, key)) throw authDatabaseSchemaError(`the \`${model}\` table of the ${JSON.stringify(database)} Database has no \`${key}\` column. ${fix}`)
    }
  }
}

/**
 * The Better Auth `database` adapter for the app Database `name` (default `"default"`). Pass it inline as the
 * `database` of `defineAuth()`. Auth then adds the Better Auth tables, with the fields of `admin()`, the
 * Console MCP OAuth tables, the table of Better Auth's limiter, the `additionalFields` of the Definition, and the tables of
 * the plugins that it calls, such as `twoFactor()` and `apiKey()`, to that Database. The adapter uses the Database of each
 * request: SQLite, libSQL, Cloudflare D1, or Postgres.
 */
export function authDatabase(name: string = "default"): AuthAppDatabase {
  const adapter = (options: Parameters<AuthAppDatabase>[0]): ReturnType<AuthAppDatabase> => {
    assertAuthDatabaseIdStrategy(options.advanced?.database?.generateId)
    assertAuthDatabaseNames(options)
    const entry = Object.hasOwn(databases, name) ? databases[name] : undefined
    if (!entry || !Object.hasOwn(entry.schema, "user")) {
      throw authErrorDiagnostics.AUTH_R0019({ message: `[vitehub] \`authDatabase(${JSON.stringify(name)})\` found no Better Auth tables in the ${JSON.stringify(name)} Database. Pass \`authDatabase()\` inline as the \`database\` of \`defineAuth()\` so that Auth adds them, enable the Database integration, and run \`vitehub database generate\`. \`vitehub inspect definitions --kind database\` lists the tables of each Database.` })
    }
    assertAuthDatabaseSchema(options, entry.schema, name)
    return drizzleAdapter(entry.db, { provider: is(entry.db, PgAsyncDatabase) ? "pg" : "sqlite", schema: entry.schema })(options)
  }
  return Object.assign(adapter, { vitehubDatabase: name })
}
