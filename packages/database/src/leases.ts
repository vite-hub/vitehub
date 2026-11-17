// A package import, not a relative one, so Nuxt and hosted builds can alias the registry to their generated runtime.
import { useDatabase } from "@vite-hub/database/runtime/registry"

import { createDatabaseLeaseStore } from "./runtime/leases.ts"

import type { LeaseStore } from "@vite-hub/runtime"
import type { IdempotencyDatabase } from "./runtime/idempotency.ts"

// SAFETY: as in `withIdempotency()`, every runtime Database is a Drizzle database, and `useDatabase()` takes any name at
// runtime and throws `DATABASE_NOT_FOUND` for an unknown one.
const lookup = useDatabase as unknown as (name?: string) => { db: IdempotencyDatabase }

const stores = new WeakMap<object, LeaseStore>()

export interface UseLeasesOptions {
  /** The Database that keeps the leases. Default: the default or only Database. */
  database?: string
}

/**
 * The leases of the app, in the table `vitehub_leases` of a Database, which the first call creates. Every server of the
 * app shares them, so one caller at a time holds a key. Works on every Database driver, including D1.
 *
 * Throws `DATABASE_NOT_FOUND` or `DATABASE_NAME_REQUIRED` when the Database does not exist or the app has several and
 * none is `default`.
 *
 * @example
 * const [error, lease] = await useLeases().acquire('search:reindex', { ttl: 30 })
 * if (lease) {
 *   try { await reindex() }
 *   finally { await lease.release() }
 * }
 */
export function useLeases(options: UseLeasesOptions = {}): LeaseStore {
  const { db } = lookup(options.database)
  let store = stores.get(db)
  if (!store) {
    store = createDatabaseLeaseStore(db)
    stores.set(db, store)
  }
  return store
}
