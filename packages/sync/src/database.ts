import { sql } from "drizzle-orm"
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

import type { AnyRelations } from "drizzle-orm"
import type { BatchItem, BatchResponse } from "drizzle-orm/batch"
import type { SQLiteAsyncDatabase } from "drizzle-orm/sqlite-core"

/**
 * The change log of every synced table, by the SQL name of the table. `seq` is the only cursor, so a pull never depends
 * on clocks. Triggers on each synced table write it, so every write reaches the browsers, also a write of server code.
 *
 * - `put`: a row was inserted or changed. Each key has one `put`, the newest. It has no row data: a pull reads the row
 *   from the table.
 * - `delete` and `move`: a row left a scope, because it was deleted or because a scope column changed. These exits
 *   are appended, one for each delete or move, and keep the key and the scope columns of the old row as JSON, by SQL
 *   column name. A pull sends the key in `deleted` only to callers whose `where` matched that row, and only when the row
 *   is not in their scope now.
 */
export const syncChanges = sqliteTable("vitehub_sync_changes", {
  seq: integer("seq").primaryKey({ autoIncrement: true }),
  tableName: text("table_name").notNull(),
  key: text("key").notNull(),
  op: text("op", { enum: ["put", "delete", "move"] }).notNull(),
  row: text("row"),
  createdAt: integer("created_at").notNull(),
}, table => [
  uniqueIndex("vitehub_sync_changes_put").on(table.tableName, table.key).where(sql`op = 'put'`),
  index("vitehub_sync_changes_seq").on(table.tableName, table.seq),
])

/**
 * The scope columns of each synced table, by SQL name: the columns of `subsets` and each column that a `where` result
 * used. The triggers record a `move` when one of them changes, and keep their old values in exits.
 */
export const syncColumns = sqliteTable("vitehub_sync_columns", {
  tableName: text("table_name").notNull(),
  column: text("column").notNull(),
}, table => [
  primaryKey({ columns: [table.tableName, table.column] }),
])

/**
 * The ids of the applied mutations, so that a retried push applies each mutation once. `result` is the JSON return
 * value of an action, so a retry gets the same result.
 */
export const syncMutations = sqliteTable("vitehub_sync_mutations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  result: text("result"),
  createdAt: integer("created_at").notNull(),
}, table => [
  index("vitehub_sync_mutations_created").on(table.createdAt),
])

/** For each synced table, the lowest cursor that a pull continues from. An older cursor gets a full snapshot. */
export const syncState = sqliteTable("vitehub_sync_state", {
  tableName: text("table_name").primaryKey(),
  floor: integer("floor").notNull(),
})

/** The tables of Sync, for `defineDatabase({ schema })` or a Database contribution. */
export const syncSchema = { syncChanges, syncColumns, syncMutations, syncState }

export { syncTableNames } from "./table-names.ts"

/** The tables of `syncSchema` as SQLite statements that are safe to run on every start. */
export const syncTables: readonly string[] = [
  "CREATE TABLE IF NOT EXISTS `vitehub_sync_changes` (`seq` integer PRIMARY KEY AUTOINCREMENT, `table_name` text NOT NULL, `key` text NOT NULL, `op` text NOT NULL, `row` text, `created_at` integer NOT NULL)",
  "CREATE UNIQUE INDEX IF NOT EXISTS `vitehub_sync_changes_put` ON `vitehub_sync_changes` (`table_name`,`key`) WHERE op = 'put'",
  "CREATE INDEX IF NOT EXISTS `vitehub_sync_changes_seq` ON `vitehub_sync_changes` (`table_name`,`seq`)",
  "CREATE TABLE IF NOT EXISTS `vitehub_sync_columns` (`table_name` text NOT NULL, `column` text NOT NULL, CONSTRAINT `vitehub_sync_columns_pk` PRIMARY KEY(`table_name`, `column`))",
  "CREATE TABLE IF NOT EXISTS `vitehub_sync_mutations` (`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL, `result` text, `created_at` integer NOT NULL)",
  "CREATE INDEX IF NOT EXISTS `vitehub_sync_mutations_created` ON `vitehub_sync_mutations` (`created_at`)",
  "CREATE TABLE IF NOT EXISTS `vitehub_sync_state` (`table_name` text PRIMARY KEY NOT NULL, `floor` integer NOT NULL)",
]

/**
 * A Drizzle SQLite Database with atomic `batch()`: libSQL, D1, or the Database of a ViteHub app. Sync writes each
 * mutation in one batch with its ledger entry, and the triggers write the change log in the same statement as the row.
 */
export type SyncDatabase = SQLiteAsyncDatabase<"async", unknown, AnyRelations> & {
  batch<U extends BatchItem<"sqlite">, T extends Readonly<[U, ...U[]]>>(queries: T): Promise<BatchResponse<T>>
}
