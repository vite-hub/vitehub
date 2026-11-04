import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

/**
 * Threads of comments. `n` is unique inside `scope`, which is what `?comment=<n>` names. `anchor`, `actor`,
 * `resolvedBy`, `metadata`, and `context` hold JSON. Times are milliseconds since the epoch.
 */
export const commentThreads = sqliteTable("vitehub_comment_threads", {
  id: text("id").primaryKey(),
  scope: text("scope").notNull(),
  n: integer("n").notNull(),
  subjectKind: text("subject_kind").notNull(),
  subjectId: text("subject_id").notNull(),
  anchor: text("anchor").notNull(),
  status: text("status", { enum: ["open", "resolved"] }).notNull(),
  resolvedBy: text("resolved_by"),
  resolvedAt: integer("resolved_at"),
  authorId: text("author_id").notNull(),
  authorName: text("author_name"),
  authorImage: text("author_image"),
  actor: text("actor"),
  /** JSON of the fields that app code keeps on the thread. */
  metadata: text("metadata"),
  /** JSON of the page, element, components, browser, and build that the overlay read. */
  context: text("context"),
  /** The version of the subject that the thread was started on. */
  revision: integer("revision"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, table => [
  uniqueIndex("vitehub_comment_threads_scope_n").on(table.scope, table.n),
  index("vitehub_comment_threads_subject").on(table.subjectKind, table.subjectId),
  index("vitehub_comment_threads_status").on(table.status, table.updatedAt),
])

/** One Markdown message. The first message of a thread is the comment. `mentions` and `attachments` hold JSON lists. */
export const commentMessages = sqliteTable("vitehub_comment_messages", {
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull(),
  body: text("body").notNull(),
  authorId: text("author_id").notNull(),
  authorName: text("author_name"),
  authorImage: text("author_image"),
  actor: text("actor"),
  mentions: text("mentions").notNull(),
  attachments: text("attachments").notNull(),
  createdAt: integer("created_at").notNull(),
  editedAt: integer("edited_at"),
}, table => [
  index("vitehub_comment_messages_thread").on(table.threadId, table.createdAt),
])

/**
 * The next thread number of each scope. A number is handed out once, so a deleted thread never gives its number to a
 * new one, and a link such as `?comment=3` keeps naming the same thread.
 */
export const commentCounters = sqliteTable("vitehub_comment_counters", {
  scope: text("scope").primaryKey(),
  next: integer("next").notNull(),
})

/**
 * The pull request comment of each message, when `defineComments({ forge })` posts threads. `id` is a message id,
 * `summary:<repository>#<pull request>`, or `cleanup:<repository>#<remote id>` for a pending delete.
 */
export const commentForge = sqliteTable("vitehub_comment_forge", {
  id: text("id").primaryKey(),
  /** Null for summaries and cleanup rows, which survive deletion of the original thread. */
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
])

/**
 * The tables of Comments, for SQLite, libSQL, and D1. ViteHub adds them to the Database for you; add them to a
 * Database Definition yourself only without ViteHub. For Postgres use `@vite-hub/comments/database/postgres`. The keys
 * carry the prefix too: ViteHub merges them into the app's Database schema, which may have its own `commentThreads`.
 */
export const commentsSchema = {
  vitehubCommentThreads: commentThreads,
  vitehubCommentMessages: commentMessages,
  vitehubCommentCounters: commentCounters,
  vitehubCommentForge: commentForge,
}
