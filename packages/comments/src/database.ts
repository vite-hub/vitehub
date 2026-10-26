import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

import type { AnySQLiteColumn, SQLiteTableWithColumns } from "drizzle-orm/sqlite-core"

type Column<Table extends string, Data, NotNull extends boolean, PrimaryKey extends boolean = false, HasDefault extends boolean = false> = AnySQLiteColumn<{
  data: Data
  hasDefault: HasDefault
  isPrimaryKey: PrimaryKey
  notNull: NotNull
  tableName: Table
}> & { _: { generated: undefined } }

type ThreadColumn<Data, NotNull extends boolean, PrimaryKey extends boolean = false, HasDefault extends boolean = false> = Column<"vitehub_comment_threads", Data, NotNull, PrimaryKey, HasDefault>
type CommentColumn<Data, NotNull extends boolean, PrimaryKey extends boolean = false> = Column<"vitehub_comments", Data, NotNull, PrimaryKey>

type ForgeColumn<Data, NotNull extends boolean, PrimaryKey extends boolean = false, HasDefault extends boolean = false> = Column<"vitehub_comment_forge", Data, NotNull, PrimaryKey, HasDefault>

/** The `vitehub_comment_forge` table, typed explicitly so its declaration can be emitted. */
export type CommentForgeTable = SQLiteTableWithColumns<{
  columns: {
    id: ForgeColumn<string, true, true>
    threadId: ForgeColumn<string, false>
    repository: ForgeColumn<string, true>
    pullRequest: ForgeColumn<number, true>
    remoteId: ForgeColumn<string, false>
    nodeId: ForgeColumn<string, false>
    url: ForgeColumn<string, false>
    digest: ForgeColumn<string, false>
    postedAs: ForgeColumn<"author" | "app", false>
    minimized: ForgeColumn<boolean, true, false, true>
    error: ForgeColumn<string, false>
    updatedAt: ForgeColumn<number, true>
  }
  dialect: "sqlite"
  name: "vitehub_comment_forge"
  schema: undefined
}>

/** The `vitehub_comment_threads` table, typed explicitly so its declaration can be emitted. */
export type CommentThreadsTable = SQLiteTableWithColumns<{
  columns: {
    id: ThreadColumn<string, true, true>
    scope: ThreadColumn<string, true, false, true>
    number: ThreadColumn<number, true, false, true>
    page: ThreadColumn<string, true>
    anchor: ThreadColumn<string, true>
    context: ThreadColumn<string, false>
    metadata: ThreadColumn<string, false>
    status: ThreadColumn<"open" | "resolved", true>
    createdBy: ThreadColumn<string, true>
    resolvedBy: ThreadColumn<string, false>
    resolvedAt: ThreadColumn<number, false>
    createdAt: ThreadColumn<number, true>
    updatedAt: ThreadColumn<number, true>
  }
  dialect: "sqlite"
  name: "vitehub_comment_threads"
  schema: undefined
}>

/** The `vitehub_comments` table, typed explicitly so its declaration can be emitted. */
export type CommentsTable = SQLiteTableWithColumns<{
  columns: {
    id: CommentColumn<string, true, true>
    threadId: CommentColumn<string, true>
    body: CommentColumn<string, true>
    mentions: CommentColumn<string, true>
    author: CommentColumn<string, true>
    createdAt: CommentColumn<number, true>
    editedAt: CommentColumn<number, false>
  }
  dialect: "sqlite"
  name: "vitehub_comments"
  schema: undefined
}>

// SAFETY: CommentThreadsTable mirrors the columns constructed here.
// doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- Drizzle's inferred table type cannot be emitted under isolatedDeclarations, so keep the public schema explicit here.
const commentThreads = sqliteTable("vitehub_comment_threads", {
  id: text("id").primaryKey(),
  /** `pages` for the overlay, or the scope that app code picks. */
  scope: text("scope").notNull().default("pages"),
  /** Counts up from 1 in each scope. */
  number: integer("number").notNull().default(0),
  /** Normalized pathname, such as `/pricing`. */
  page: text("page").notNull(),
  /** JSON of the anchor, `null` for threads that app code anchors itself. */
  anchor: text("anchor").notNull(),
  /** JSON of the page, element, components, browser, and build. */
  context: text("context"),
  /** JSON of the fields that app code keeps on the thread. */
  metadata: text("metadata"),
  status: text("status", { enum: ["open", "resolved"] }).notNull(),
  /** JSON of the author who opened the thread. */
  createdBy: text("created_by").notNull(),
  resolvedBy: text("resolved_by"),
  resolvedAt: integer("resolved_at"),
  /** Milliseconds since the epoch. */
  createdAt: integer("created_at").notNull(),
  /** The last comment, resolve, or reopen. */
  updatedAt: integer("updated_at").notNull(),
}, table => [
  index("vitehub_comment_threads_page").on(table.page, table.status),
  uniqueIndex("vitehub_comment_threads_number").on(table.scope, table.number),
  index("vitehub_comment_threads_updated").on(table.updatedAt),
]) as unknown as CommentThreadsTable

// SAFETY: CommentsTable mirrors the columns constructed here.
// doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- Drizzle's inferred table type cannot be emitted under isolatedDeclarations, so keep the public schema explicit here.
const comments = sqliteTable("vitehub_comments", {
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull().references(() => commentThreads.id, { onDelete: "cascade" }),
  body: text("body").notNull(),
  /** JSON array of `{ id, name }`. */
  mentions: text("mentions").notNull(),
  /** JSON of the author. */
  author: text("author").notNull(),
  createdAt: integer("created_at").notNull(),
  editedAt: integer("edited_at"),
}, table => [
  index("vitehub_comments_thread").on(table.threadId, table.createdAt),
]) as unknown as CommentsTable

// SAFETY: CommentForgeTable mirrors the columns constructed here.
// doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- Drizzle's inferred table type cannot be emitted under isolatedDeclarations, so keep the public schema explicit here.
const commentForge = sqliteTable("vitehub_comment_forge", {
  /** The comment that the row posts, or `summary:<repository>#<pull request>` for the summary comment. */
  id: text("id").primaryKey(),
  /** Null for the summary comment. */
  threadId: text("thread_id"),
  repository: text("repository").notNull(),
  pullRequest: integer("pull_request").notNull(),
  /** The forge's id of the comment. Null until it posts. */
  remoteId: text("remote_id"),
  /** The GraphQL id, to hide the comment of a resolved thread. */
  nodeId: text("node_id"),
  url: text("url"),
  /** Hash of the body the forge has, so an unchanged comment is not sent again. */
  digest: text("digest"),
  postedAs: text("posted_as", { enum: ["author", "app"] }),
  /** Whether the forge hides the comment, because its thread is resolved. */
  minimized: integer("minimized", { mode: "boolean" }).notNull().default(false),
  error: text("error"),
  updatedAt: integer("updated_at").notNull(),
}, table => [
  index("vitehub_comment_forge_thread").on(table.threadId),
  index("vitehub_comment_forge_pull_request").on(table.repository, table.pullRequest),
]) as unknown as CommentForgeTable

/**
 * The tables behind Comments. `vitehub_comment_forge` holds the pull request comments of `defineComments({ forge })`. ViteHub adds them to the Database of `defineComments({ database })` for you; add them
 * yourself only to a Database that you configure without ViteHub. Apply the migration that `vitehub db generate` writes.
 */
// The keys carry the prefix too: ViteHub merges them into the app's Database schema, which may have its own `comments`.
export const commentsSchema: { vitehubCommentThreads: CommentThreadsTable, vitehubComments: CommentsTable, vitehubCommentForge: CommentForgeTable } = { vitehubCommentThreads: commentThreads, vitehubComments: comments, vitehubCommentForge: commentForge }
export { commentsTables } from "./tables.ts"
