import type { Client } from "@libsql/client"
import type { DrizzleConfig } from "drizzle-orm"

declare module "drizzle-orm/libsql/driver-core" {
  /**
   * Builds Drizzle's libSQL database on a client. Every `drizzle-orm/libsql/*` entry calls it after it creates its
   * client, but drizzle-orm marks it `@internal`. It is the only libSQL entry that imports no client, so a client that
   * loads on the first query can use it. `test/libsql-startup.test.ts` fails when it goes away.
   */
  export function construct<TSchema extends Record<string, unknown> = Record<string, never>>(
    client: Client,
    config?: DrizzleConfig<TSchema>,
  ): LibSQLDatabase<TSchema> & { $client: Client }
}
