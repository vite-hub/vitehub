import { createTableRelationsHelpers, DefaultLogger, extractTablesRelationalConfig } from "drizzle-orm"
import { LibSQLDatabase } from "drizzle-orm/libsql/driver-core"
import { LibSQLSession } from "drizzle-orm/libsql/session"
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core"

import type { Client } from "@libsql/client"
import type { DrizzleConfig, ExtractTablesWithRelations, Logger, RelationalSchemaConfig } from "drizzle-orm"

/**
 * Drizzle's libSQL database on a client, as `drizzle(client, config)` from `drizzle-orm/libsql` makes it. That entry
 * imports `@libsql/client`, and drizzle-orm keeps its client-free `construct()` internal, so this builds the same
 * database from drizzle-orm's typed exports. A drizzle-orm change to these constructors fails the typecheck, and
 * `test/libsql-drizzle.test.ts` compares the result with `drizzle()`.
 */
export function createLibsqlDrizzle<TSchema extends Record<string, unknown> = Record<string, never>>(
  client: Client,
  config: DrizzleConfig<TSchema> = {},
): LibSQLDatabase<TSchema> & { $client: Client } {
  const dialect = new SQLiteAsyncDialect({ casing: config.casing })
  const logger: Logger | undefined = config.logger === true ? new DefaultLogger() : config.logger || undefined
  let schema: RelationalSchemaConfig<ExtractTablesWithRelations<TSchema>> | undefined
  if (config.schema) {
    const tables = extractTablesRelationalConfig<ExtractTablesWithRelations<TSchema>>(config.schema, createTableRelationsHelpers)
    schema = { fullSchema: config.schema, schema: tables.tables, tableNamesMap: tables.tableNamesMap }
  }
  const session = new LibSQLSession<TSchema, ExtractTablesWithRelations<TSchema>>(client, dialect, schema, { cache: config.cache, logger }, undefined)
  const db = Object.assign(new LibSQLDatabase<TSchema>("async", dialect, session, schema), { $client: client })
  const cache = config.cache
  if (cache) db.$cache = { invalidate: params => cache.onMutate(params) }
  return db
}
