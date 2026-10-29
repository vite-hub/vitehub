import { bigint, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core"

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

/**
 * The tables behind the comment operations, for Postgres. Add them to a Database Definition yourself
 * and apply their migration, or let `hubComments()` contribute them. For SQLite, libSQL, and D1 use `@vite-hub/comments/database`.
 */
export const commentsPostgresSchema = { commentThreads, commentMessages, commentCounters }
