// `authDatabase()` connects Better Auth to a ViteHub Database. The Auth Vite plugin finds the call in the Auth
// Definition and adds the Better Auth tables to that Database, so `vitehub db generate` writes their migration.
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { databases } from "@vite-hub/database/drizzle"
import { is } from "drizzle-orm"
import { PgDatabase } from "drizzle-orm/pg-core"

import { authErrorDiagnostics } from "./error-diagnostics.ts"
import { assertAuthDatabaseIdStrategy } from "./database-options.ts"

import type { AuthAppDatabase } from "./types.ts"

export type { AuthAppDatabase } from "./types.ts"

/**
 * The Better Auth `database` adapter for the app Database `name` (default `"default"`). Pass it inline as the
 * `database` of `defineAuth()`. Auth then adds the Better Auth tables, with the fields of `admin()` and the
 * Console MCP OAuth tables, to that Database. The adapter uses the Database of each request: SQLite, libSQL,
 * Cloudflare D1, or Postgres.
 */
export function authDatabase(name: string = "default"): AuthAppDatabase {
  const adapter = (options: Parameters<AuthAppDatabase>[0]): ReturnType<AuthAppDatabase> => {
    assertAuthDatabaseIdStrategy(options.advanced?.database?.generateId)
    const entry = Object.hasOwn(databases, name) ? databases[name] : undefined
    if (!entry || !Object.hasOwn(entry.schema, "user")) {
      throw authErrorDiagnostics.AUTH_R0019({ message: `[vitehub] \`authDatabase(${JSON.stringify(name)})\` found no Better Auth tables in the ${JSON.stringify(name)} Database. Pass \`authDatabase()\` inline as the \`database\` of \`defineAuth()\` so that Auth adds them, enable the Database integration, and run \`vitehub db generate\`. \`vitehub inspect definitions --kind database\` lists the tables of each Database.` })
    }
    return drizzleAdapter(entry.db, { provider: is(entry.db, PgDatabase) ? "pg" : "sqlite", schema: entry.schema })(options)
  }
  return Object.assign(adapter, { vitehubDatabase: name })
}
