import { databaseErrorDiagnostics } from "../error-diagnostics.ts"

import type { Client, InStatement, InValue, ResultSet, Transaction, TransactionMode } from "@libsql/client"

/**
 * An in-memory SQLite client for app tests. It applies the Drizzle Kit migrations of `migrationsDir`, relative to `root`, before the first
 * query, so each test starts with the tables of the app and no rows. Drizzle needs the client synchronously, so this
 * one waits for the real client inside each call.
 */
export function createTestDatabaseClient(root: string, migrationsDir: string): Client {
  const ready = (async () => {
    const [{ createClient }, { existsSync }, { resolve }] = await Promise.all([
      import("@libsql/client"),
      import("node:fs"),
      import("node:path"),
    ])
    const migrationsFolder = resolve(root, migrationsDir)
    if (existsSync(resolve(migrationsFolder, "meta/_journal.json"))) throw databaseErrorDiagnostics.DATABASE_MIGRATIONS_OLD_LAYOUT({ dir: migrationsFolder })
    const client = createClient({ url: ":memory:" })
    if (existsSync(migrationsFolder)) {
      // Drizzle reads the `<timestamp>_<name>/migration.sql` folders of Drizzle Kit 1.0.
      const { readMigrationFiles } = await import("drizzle-orm/migrator")
      for (const migration of readMigrationFiles({ migrationsFolder })) {
        await client.migrate(migration.sql.filter(statement => statement.trim()))
      }
    }
    return client
  })()

  let closed = false
  return {
    get closed() { return closed },
    protocol: "file",
    async batch(statements: InStatement[], mode?: TransactionMode): Promise<ResultSet[]> { return await (await ready).batch(statements, mode) },
    close() {
      closed = true
      void ready.then(client => client.close(), () => {})
    },
    async execute(statement: InStatement | string, args?: InValue[]): Promise<ResultSet> {
      const client = await ready
      return typeof statement === "string" && args ? await client.execute(statement, args) : await client.execute(statement)
    },
    async executeMultiple(sql: string): Promise<void> { await (await ready).executeMultiple(sql) },
    async migrate(statements: InStatement[]): Promise<ResultSet[]> { return await (await ready).migrate(statements) },
    async reconnect(): Promise<void> { await (await ready).reconnect() },
    async sync(): Promise<undefined> { return undefined },
    async transaction(mode?: TransactionMode): Promise<Transaction> { return await (await ready).transaction(mode) },
  }
}
