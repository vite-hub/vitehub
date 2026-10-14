import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"

export interface HistoryManifestFile {
  digest: string
  size: number
  mediaType: string
  metadata?: Record<string, unknown>
}

// One row per Workspace identity. The tombstone fences every ref after deletion.
const workspaces = sqliteTable("workspace_history_workspaces", {
  workspace: text("workspace").primaryKey(),
  deleted: integer("deleted", { mode: "boolean" }).notNull().default(false),
})

// Named heads inside one Workspace. Revisions and objects are shared across refs.
const refs = sqliteTable("workspace_history_refs", {
  workspace: text("workspace").notNull(),
  ref: text("ref").notNull(),
  head: text("head"),
  sequence: integer("sequence").notNull().default(0),
}, table => [primaryKey({ columns: [table.workspace, table.ref] })])

const revisions = sqliteTable("workspace_history_revisions", {
  workspace: text("workspace").notNull(),
  id: text("id").notNull(),
  ref: text("ref").notNull(),
  parentId: text("parent_id"),
  sequence: integer("sequence").notNull(),
  createdAt: text("created_at").notNull(),
  message: text("message"),
  metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
  files: integer("files").notNull(),
  bytes: integer("bytes").notNull(),
  entries: text("entries", { mode: "json" }).$type<Record<string, HistoryManifestFile>>().notNull(),
  // False until the ref head moves to this revision. Losing candidates stay false.
  committed: integer("committed", { mode: "boolean" }).notNull().default(false),
}, table => [
  primaryKey({ columns: [table.workspace, table.id] }),
  index("workspace_history_timeline").on(table.workspace, table.ref, table.committed, table.sequence),
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
export const workspaceHistorySchema = { workspaceHistoryWorkspaces: workspaces, workspaceHistoryRefs: refs, workspaceHistoryRevisions: revisions, workspaceHistoryObjects: objects, workspaceHistoryMetadata: metadata }
