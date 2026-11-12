import { DefaultLogger } from "drizzle-orm"
import { libsqlCodecs } from "drizzle-orm/libsql/codecs"
import { LibSQLDatabase } from "drizzle-orm/libsql/driver-core"
import { LibSQLSession } from "drizzle-orm/libsql/session"
import { SQLiteDialect } from "drizzle-orm/sqlite-core"

import type { Client } from "@libsql/client"
import type { AnyRelations, DrizzleConfig, EmptyRelations, Logger } from "drizzle-orm"

/**
 * Drizzle's libSQL database on a client, as `drizzle({ client, ...config })` from `drizzle-orm/libsql` makes it. That
 * entry imports `@libsql/client`, and drizzle-orm keeps its client-free `construct()` internal, so this builds the same
 * database from drizzle-orm's typed exports. A drizzle-orm change to these constructors fails the typecheck, and
 * `test/libsql-drizzle.test.ts` compares the result with `drizzle()`.
 */
export function createLibsqlDrizzle<TRelations extends AnyRelations = EmptyRelations>(
  client: Client,
  config: Omit<DrizzleConfig<TRelations>, "jit"> = {},
): LibSQLDatabase<TRelations> & { $client: Client } {
  const dialect = new SQLiteDialect({ codecs: libsqlCodecs })
  const logger: Logger | undefined = config.logger === true ? new DefaultLogger() : config.logger || undefined
  // SAFETY: `drizzle()` uses the same empty object when it has no relations, and `EmptyRelations` is `{}`.
  const relations = config.relations ?? ({} as TRelations)
  const session = new LibSQLSession(client, dialect, relations, { cache: config.cache, logger, paramsInErrors: config.paramsInErrors }, undefined)
  const db = Object.assign(new LibSQLDatabase<TRelations>("async", dialect, session, relations), { $client: client })
  const cache = config.cache
  if (cache) {
    // `construct()` sets the same undeclared `$cache`, so `db.$cache.invalidate()` works as it does on `drizzle()`.
    Object.assign(db, { $cache: Object.assign(cache, { invalidate: cache.onMutate.bind(cache) }) })
  }
  return db
}
