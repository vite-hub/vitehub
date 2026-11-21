// A package import, not a relative one, so Nuxt and hosted builds can alias the registry to their generated runtime.
import { useDatabase } from "@vite-hub/database/runtime/registry"

import { runIdempotent } from "./runtime/idempotency.ts"

import type { Result } from "@vite-hub/runtime"
import type { IdempotencyDatabase, WithIdempotencyErrorCode, WithIdempotencyOptions } from "./runtime/idempotency.ts"

// SAFETY: the generated registry narrows the names, and every runtime Database is a Drizzle database: Postgres has
// `execute()`, SQLite has `all()`. At runtime, `useDatabase()` takes any name and throws `DATABASE_NOT_FOUND`.
const lookup = useDatabase as unknown as (name?: string) => { db: IdempotencyDatabase }

/** `useDatabase()` with a runtime name, for helpers such as `useLeases()` that take `{ database }`. */
export { lookup as lookupDrizzleDatabase }

export type { WithIdempotencyErrorCode, WithIdempotencyOptions } from "./runtime/idempotency.ts"

/**
 * Runs `fn` once for `key`, such as a Stripe event id or a queue message id, across every instance of the app. A repeat
 * gets the stored result without running `fn`. A repeat while the first call runs gets
 * `DATABASE_IDEMPOTENCY_IN_PROGRESS`. When `fn` throws, the key is free again, so a retry runs `fn` again.
 *
 * The keys live in the table `vitehub_idempotency_keys` of the Database, which the first call creates. The result must
 * be JSON: a repeat gets `JSON.parse(JSON.stringify(result))`.
 *
 * @example
 * const [error] = await withIdempotency(`stripe:${event.id}`, () => fulfilOrder(event))
 * if (error) throw new HTTPError({ status: 409, statusText: error.why })
 */
export function withIdempotency<T>(
  key: string,
  fn: () => T | PromiseLike<T>,
  options: WithIdempotencyOptions = {},
): Promise<Result<Awaited<T>, WithIdempotencyErrorCode>> {
  const { database, ...rest } = options
  return runIdempotent(lookup(database).db, key, fn, rest)
}
