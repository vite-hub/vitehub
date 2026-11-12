import { createSqlLeaseStore } from "@vite-hub/runtime"

import type { LeaseSqlParam, LeaseStore } from "@vite-hub/runtime"

interface PostgresClient {
  unsafe(sql: string, params: LeaseSqlParam[]): Promise<readonly Record<string, unknown>[]>
}

interface LibsqlClient {
  execute(statement: { args: LeaseSqlParam[], sql: string }): Promise<{ rows: readonly Record<string, unknown>[] }>
}

function hasMethod(value: unknown, name: string): boolean {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return false
  return typeof Reflect.get(value, name) === "function"
}

/**
 * Leases in the `vitehub_leases` table of a Drizzle database from `@vite-hub/database`, on postgres.js or libSQL. The
 * generated Process Runtime uses it on the Default Database, so every server of the app claims occurrences in one
 * place. The client is read on each query, as a Database can change it. Returns `undefined` when the Database has
 * neither client, such as D1, or is not configured.
 *
 * On a local libSQL file it warns once: `@libsql/client` 0.18 can lose committed writes when several processes write
 * to one file, so two processes can both get a lease there. One process on the file is safe.
 */
export function scheduleLeaseStoreFromDatabase(db: object): LeaseStore | undefined {
  const client = (): unknown => Reflect.get(db, "$client")
  let first: unknown
  try {
    first = client()
  }
  catch {
    // A Database that is not configured throws on any property read.
    return undefined
  }
  const dialect = hasMethod(first, "unsafe") ? "postgresql" : hasMethod(first, "execute") ? "sqlite" : undefined
  if (!dialect) return undefined
  if (dialect === "sqlite" && Reflect.get(Object(first), "protocol") === "file") {
    console.warn("[vitehub:schedule] The Default Database is a local libSQL file. @libsql/client can lose writes when several processes write to one file, so two server processes can run the same Schedule occurrence. Run one server process on the file, or use Postgres or remote libSQL.")
  }
  return createSqlLeaseStore({
    dialect,
    async query(sql, params) {
      // SAFETY: The dialect check above found the method that each branch calls.
      if (dialect === "postgresql") return await (client() as PostgresClient).unsafe(sql, params)
      // SAFETY: As above, a libSQL client has `execute()`.
      return (await (client() as LibsqlClient).execute({ args: params, sql })).rows
    },
  })
}
