import { localLibsql } from "./local-client.ts"
import { resolveLocalSqliteUrl } from "./local-url.ts"
import { createTestDatabaseClient } from "./test-database.ts"

import type { LocalSqlite } from "./drizzle-adapter.ts"

/** `#vitehub/database/libsql` in every build that can open a local or libSQL database. */
export const localSqlite: LocalSqlite | undefined = {
  ...localLibsql,
  createTestClient: createTestDatabaseClient,
  resolveLocalUrl: resolveLocalSqliteUrl,
}
