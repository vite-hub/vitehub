import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"

export interface HistoryManifestFile {
  digest: string
  size: number
  mediaType: string
  metadata?: Record<string, unknown>
}

const refs = sqliteTable("workspace_history_refs", {
  workspace: text("workspace").primaryKey(),
  head: text("head"),
  sequence: integer("sequence").notNull().default(0),
  deleted: integer("deleted", { mode: "boolean" }).notNull().default(false),
})

const revisions = sqliteTable("workspace_history_revisions", {
  workspace: text("workspace").notNull(),
  id: text("id").notNull(),
  parentId: text("parent_id"),
  sequence: integer("sequence").notNull(),
  createdAt: text("created_at").notNull(),
  message: text("message"),
  metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
  files: integer("files").notNull(),
  bytes: integer("bytes").notNull(),
  entries: text("entries", { mode: "json" }).$type<Record<string, HistoryManifestFile>>().notNull(),
  published: integer("published", { mode: "boolean" }).notNull().default(false),
}, table => [
  primaryKey({ columns: [table.workspace, table.id] }),
  index("workspace_history_timeline").on(table.workspace, table.published, table.sequence),
])

// Register before upload so deletion can find objects from failed publications.
const objects = sqliteTable("workspace_history_objects", {
  workspace: text("workspace").notNull(),
  digest: text("digest").notNull(),
  size: integer("size").notNull(),
}, table => [primaryKey({ columns: [table.workspace, table.digest] })])

const metadata = sqliteTable("workspace_history_metadata", {
  workspace: text("workspace").notNull(),
  key: text("key").notNull(),
  value: text("value", { mode: "json" }).$type<unknown>().notNull(),
}, table => [primaryKey({ columns: [table.workspace, table.key] })])

/** Include these tables in a Database Definition and apply its migrations. */
export const workspaceHistorySchema = { workspaceHistoryRefs: refs, workspaceHistoryRevisions: revisions, workspaceHistoryObjects: objects, workspaceHistoryMetadata: metadata }
