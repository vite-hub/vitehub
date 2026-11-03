import { bigint, boolean, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core"

/**
 * Threads of comments. `n` is unique inside `scope`, which is what `?comment=<n>` names. `anchor`, `actor`, and
 * `resolvedBy` hold JSON. Times are milliseconds since the epoch.
 */
export const commentThreads = pgTable("vitehub_comment_threads", {
  id: text("id").primaryKey(),
  scope: text("scope").notNull(),
  n: bigint("n", { mode: "number" }).notNull(),
  subjectKind: text("subject_kind").notNull(),
  subjectId: text("subject_id").notNull(),
  anchor: text("anchor").notNull(),
  status: text("status", { enum: ["open", "resolved"] }).notNull(),
  resolvedBy: text("resolved_by"),
  resolvedAt: bigint("resolved_at", { mode: "number" }),
  authorId: text("author_id").notNull(),
  authorName: text("author_name"),
  authorImage: text("author_image"),
  actor: text("actor"),
  metadata: text("metadata"),
  context: text("context"),
  revision: bigint("revision", { mode: "number" }),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, table => [
  uniqueIndex("vitehub_comment_threads_scope_n").on(table.scope, table.n),
  index("vitehub_comment_threads_subject").on(table.subjectKind, table.subjectId),
  index("vitehub_comment_threads_status").on(table.status, table.updatedAt),
])

/** One Markdown message. The first message of a thread is the comment. `mentions` and `attachments` hold JSON lists. */
export const commentMessages = pgTable("vitehub_comment_messages", {
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull(),
  body: text("body").notNull(),
  authorId: text("author_id").notNull(),
  authorName: text("author_name"),
  authorImage: text("author_image"),
  actor: text("actor"),
  mentions: text("mentions").notNull(),
  attachments: text("attachments").notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  editedAt: bigint("edited_at", { mode: "number" }),
}, table => [
  index("vitehub_comment_messages_thread").on(table.threadId, table.createdAt),
])

/**
 * The next thread number of each scope. A number is handed out once, so a deleted thread never gives its number to a
 * new one, and a link such as `?comment=3` keeps naming the same thread.
 */
export const commentCounters = pgTable("vitehub_comment_counters", {
  scope: text("scope").primaryKey(),
  next: bigint("next", { mode: "number" }).notNull(),
})

/** The pull request comment of each message, when `defineComments({ forge })` posts threads. */
export const commentForge = pgTable("vitehub_comment_forge", {
  id: text("id").primaryKey(),
  threadId: text("thread_id"),
  repository: text("repository").notNull(),
  pullRequest: bigint("pull_request", { mode: "number" }).notNull(),
  remoteId: text("remote_id"),
  nodeId: text("node_id"),
  url: text("url"),
  digest: text("digest"),
  postedAs: text("posted_as", { enum: ["author", "app"] }),
  minimized: boolean("minimized").notNull().default(false),
  error: text("error"),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, table => [
  index("vitehub_comment_forge_thread").on(table.threadId),
  index("vitehub_comment_forge_pull_request").on(table.repository, table.pullRequest),
])

/**
 * The tables of Comments, for Postgres. ViteHub adds them to the Database for you; add them to a Database Definition
 * yourself only without ViteHub. For SQLite, libSQL, and D1 use `@vite-hub/comments/database`.
 */
export const commentsPostgresSchema = {
  vitehubCommentThreads: commentThreads,
  vitehubCommentMessages: commentMessages,
  vitehubCommentCounters: commentCounters,
  vitehubCommentForge: commentForge,
}
