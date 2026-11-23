import { bigint, boolean, index, integer, json, jsonb, pgTable, primaryKey, text } from "drizzle-orm/pg-core"

import type { HistoryManifestFile } from "./history-schema.ts"

export type HistoryFileIndex = Record<string, Pick<HistoryManifestFile, "digest" | "size"> & { fingerprint: string }>

const workspaces = pgTable("workspace_history_workspaces", {
  workspace: text("workspace").primaryKey(),
  deleted: boolean("deleted").notNull().default(false),
})

const refs = pgTable("workspace_history_refs", {
  workspace: text("workspace").notNull(),
  ref: text("ref").notNull(),
  head: text("head"),
  sequence: integer("sequence").notNull().default(0),
}, table => [primaryKey({ columns: [table.workspace, table.ref] })])

const revisions = pgTable("workspace_history_revisions", {
  workspace: text("workspace").notNull(),
  id: text("id").notNull(),
  ref: text("ref").notNull(),
  parentId: text("parent_id"),
  sequence: integer("sequence").notNull(),
  createdAt: text("created_at").notNull(),
  message: text("message"),
  metadata: json("metadata").$type<Record<string, unknown>>(),
  files: integer("files").notNull(),
  bytes: bigint("bytes", { mode: "number" }).notNull(),
  entries: json("entries").$type<Record<string, HistoryManifestFile>>().notNull(),
  fileIndex: jsonb("file_index").$type<HistoryFileIndex>().notNull(),
  committed: boolean("committed").notNull().default(false),
}, table => [
  primaryKey({ columns: [table.workspace, table.id] }),
  index("workspace_history_timeline").on(table.workspace, table.ref, table.committed, table.sequence),
])

const objects = pgTable("workspace_history_objects", {
  workspace: text("workspace").notNull(),
  digest: text("digest").notNull(),
  size: bigint("size", { mode: "number" }).notNull(),
}, table => [primaryKey({ columns: [table.workspace, table.digest] })])

const metadata = pgTable("workspace_history_metadata", {
  workspace: text("workspace").notNull(),
  key: text("key").notNull(),
  value: json("value").$type<unknown>().notNull(),
}, table => [primaryKey({ columns: [table.workspace, table.key] })])

/** Include these tables in a Postgres Database Definition and apply its migrations. */
export const workspaceHistorySchema = { workspaceHistoryWorkspaces: workspaces, workspaceHistoryRefs: refs, workspaceHistoryRevisions: revisions, workspaceHistoryObjects: objects, workspaceHistoryMetadata: metadata }
