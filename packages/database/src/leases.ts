import { lookupDrizzleDatabase as lookup } from "./idempotency.ts"
import { createDatabaseLeaseStore } from "./runtime/leases.ts"

import type { LeaseStore } from "@vite-hub/runtime"

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
