import { createSqlLeaseStore } from "@vite-hub/runtime"
import { getViteHubTestMode } from "@vite-hub/runtime/internal/test-mode"
import { sql } from "drizzle-orm"

import { postgresConnectionUrl } from "./postgres-connection.ts"
import { queryRows } from "./idempotency.ts"

import type { LeaseSqlClient, LeaseSqlParam, LeaseStore } from "@vite-hub/runtime"
import type { SQL } from "drizzle-orm"
import type { IdempotencyDatabase } from "./idempotency.ts"

/** Turns lease SQL with `?` or `$1` placeholders into a Drizzle query, so each driver binds the values its own way. */
function toQuery(text: string, params: LeaseSqlParam[]): SQL {
  const chunks: SQL[] = []
  let last = 0
  let next = 0
  for (const match of text.matchAll(/\$(\d+)|\?/g)) {
    chunks.push(sql.raw(text.slice(last, match.index)))
    chunks.push(sql`${params[match[1] ? Number(match[1]) - 1 : next++]}`)
    last = match.index + match[0].length
  }
  chunks.push(sql.raw(text.slice(last)))
  return sql.join(chunks)
}

let localFileWarned = false

function leaseClient(db: IdempotencyDatabase): LeaseSqlClient {
  // A Postgres Database answers the connection URL symbol without opening a client. Other Postgres Drizzle databases
  // have `execute()`, SQLite ones have `all()`.
  const dialect = typeof Reflect.get(db, postgresConnectionUrl) === "function" || db.execute ? "postgresql" : "sqlite"
  if (dialect === "sqlite" && !localFileWarned && !getViteHubTestMode() && Reflect.get(Object(Reflect.get(db, "$client")), "protocol") === "file") {
    localFileWarned = true
    console.warn("[vitehub:database] Leases are in a local libSQL file. @libsql/client can lose writes when several processes write to one file, so two server processes can hold the same lease. Run one server process on the file, or use Postgres, remote libSQL, or D1.")
  }
  return { dialect, query: (text, params) => queryRows(db, toQuery(text, params)) }
}

/**
 * Leases in the `vitehub_leases` table of a Drizzle database, on every Database driver: postgres.js, node-postgres,
 * PGlite, libSQL, and D1. Each operation is one statement, so D1 needs no transaction. The store reads the database
 * on the first operation, where a D1 binding is active. When that read fails, such as outside a request on D1, the
 * operation returns `RUNTIME_LEASE_FAILED` with the error as `cause`, and the next operation reads the database again.
 */
export function createDatabaseLeaseStore(db: IdempotencyDatabase): LeaseStore {
  let store: LeaseStore | undefined
  function resolve(): LeaseStore {
    if (store) return store
    try {
      store = createSqlLeaseStore(leaseClient(db))
      return store
    }
    catch (cause) {
      return createSqlLeaseStore({ dialect: "sqlite", query: async () => { throw cause } })
    }
  }
  return {
    acquire: async (key, options) => await resolve().acquire(key, options),
    get: async key => await resolve().get(key),
  }
}
