import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"

import type { AnySQLiteColumn, SQLiteTableWithColumns } from "drizzle-orm/sqlite-core"

type SessionColumn<Data, NotNull extends boolean, PrimaryKey extends boolean = false> = AnySQLiteColumn<{
  data: Data
  hasDefault: false
  isPrimaryKey: PrimaryKey
  notNull: NotNull
  tableName: "vitehub_content_sessions"
}> & { _: { generated: undefined } }

/** The `vitehub_content_sessions` table, typed explicitly so its declaration can be emitted. */
export type ContentSessionsTable = SQLiteTableWithColumns<{
  columns: {
    workspace: SessionColumn<string, true>
    collection: SessionColumn<string, true>
    document: SessionColumn<string, true>
    session: SessionColumn<string, true>
    userId: SessionColumn<string, true>
    userName: SessionColumn<string, false>
    userImage: SessionColumn<string, false>
    kind: SessionColumn<"view" | "edit" | "live", true>
    acquiredAt: SessionColumn<number, false>
    renewedAt: SessionColumn<number, true>
    expiresAt: SessionColumn<number, true>
    lastInputAt: SessionColumn<number, false>
  }
  dialect: "sqlite"
  name: "vitehub_content_sessions"
  schema: undefined
}>

/**
 * One row per editor session on one document: who has it open, whether they view or edit it, and how long that holds.
 * Times are milliseconds since the epoch from the Database clock, so every host agrees on expiry.
 */
// doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- Drizzle's inferred table type cannot be emitted under isolatedDeclarations, so keep the public schema explicit here.
// SAFETY: ContentSessionsTable mirrors the columns constructed here.
const contentSessions = sqliteTable("vitehub_content_sessions", {
  workspace: text("workspace").notNull(),
  collection: text("collection").notNull(),
  document: text("document").notNull(),
  /** A token per browser tab or client, not per user, so two tabs of one user never share a lease. */
  session: text("session").notNull(),
  userId: text("user_id").notNull(),
  userName: text("user_name"),
  userImage: text("user_image"),
  /**
   * `edit` while the session holds the edit lease of the document, `live` while a Realtime room holds it for everyone
   * in the room, otherwise `view`. SQLite stores it as text without a check, so `live` needs no migration.
   */
  kind: text("kind", { enum: ["view", "edit", "live"] }).notNull(),
  /** When the session took the edit lease. Null while it views. */
  acquiredAt: integer("acquired_at"),
  /** The last report of the session. */
  renewedAt: integer("renewed_at").notNull(),
  /** When the row stops counting: 45 seconds after a report, or 5 minutes after a lease renewal. */
  expiresAt: integer("expires_at").notNull(),
  /** The last input the session reported. A lease without input for 15 minutes no longer blocks others. */
  lastInputAt: integer("last_input_at"),
}, table => [
  primaryKey({ columns: [table.workspace, table.collection, table.document, table.session] }),
  index("vitehub_content_sessions_expiry").on(table.workspace, table.expiresAt),
]) as unknown as ContentSessionsTable

/**
 * The table behind `content.sessions`: presence and edit leases of Content documents. Add it to the Database of the
 * Content Workspace, next to `workspaceHistorySchema`, and apply its migration.
 */
export const contentSessionsSchema: { contentSessions: ContentSessionsTable } = { contentSessions }
