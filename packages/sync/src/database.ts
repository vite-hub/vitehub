import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

import type { AnyRelations } from "drizzle-orm"
import type { BatchItem, BatchResponse } from "drizzle-orm/batch"
import type { SQLiteAsyncDatabase } from "drizzle-orm/sqlite-core"

/**
 * The change log: one entry for each key of each Sync definition, the newest. `seq` is the only cursor, so a pull
 * never depends on clocks. A `delete` keeps the deleted row as JSON, so a pull sends the key only to callers whose
 * `where` matches the row.
 */
export const syncChanges = sqliteTable("vitehub_sync_changes", {
  seq: integer("seq").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  key: text("key").notNull(),
  op: text("op", { enum: ["put", "delete"] }).notNull(),
  row: text("row"),
  createdAt: integer("created_at").notNull(),
}, table => [
  uniqueIndex("vitehub_sync_changes_key").on(table.name, table.key),
  index("vitehub_sync_changes_seq").on(table.name, table.seq),
])

/** The ids of the applied mutations, so that a retried push applies each mutation once. */
export const syncMutations = sqliteTable("vitehub_sync_mutations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: integer("created_at").notNull(),
}, table => [
  index("vitehub_sync_mutations_created").on(table.createdAt),
])

/** For each Sync definition, the highest `seq` that compaction removed. An older cursor gets a full snapshot. */
export const syncState = sqliteTable("vitehub_sync_state", {
  name: text("name").primaryKey(),
  floor: integer("floor").notNull(),
})

/** The tables of Sync, for `defineDatabase({ schema })` or a Database contribution. */
export const syncSchema = { syncChanges, syncMutations, syncState }

export { syncTableNames } from "./table-names.ts"

/** The tables of `syncSchema` as SQLite statements that are safe to run on every start. */
export const syncTables: readonly string[] = [
  "CREATE TABLE IF NOT EXISTS `vitehub_sync_changes` (`seq` integer PRIMARY KEY AUTOINCREMENT, `name` text NOT NULL, `key` text NOT NULL, `op` text NOT NULL, `row` text, `created_at` integer NOT NULL)",
  "CREATE UNIQUE INDEX IF NOT EXISTS `vitehub_sync_changes_key` ON `vitehub_sync_changes` (`name`,`key`)",
  "CREATE INDEX IF NOT EXISTS `vitehub_sync_changes_seq` ON `vitehub_sync_changes` (`name`,`seq`)",
  "CREATE TABLE IF NOT EXISTS `vitehub_sync_mutations` (`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL, `created_at` integer NOT NULL)",
  "CREATE INDEX IF NOT EXISTS `vitehub_sync_mutations_created` ON `vitehub_sync_mutations` (`created_at`)",
  "CREATE TABLE IF NOT EXISTS `vitehub_sync_state` (`name` text PRIMARY KEY NOT NULL, `floor` integer NOT NULL)",
]

/**
 * A Drizzle SQLite Database with atomic `batch()`: libSQL, D1, or the Database of a ViteHub app. Sync writes each
 * mutation in one batch, so a row and its change log entry are saved together or not at all.
 */
export type SyncDatabase = SQLiteAsyncDatabase<"async", unknown, AnyRelations> & {
  batch<U extends BatchItem<"sqlite">, T extends Readonly<[U, ...U[]]>>(queries: T): Promise<BatchResponse<T>>
}
