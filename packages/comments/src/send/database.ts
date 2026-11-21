import { sql } from "drizzle-orm"
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

/** Where a send is: delivered, read by the agent, answered, or not delivered. */
export type CommentSendState = "pending" | "sent" | "working" | "done" | "failed"

/**
 * One row for each send: the member, the threads it carried with the last message of each, and the read token. `threads`
 * holds JSON, `[{ id, message, role }]`, and `sender` the member as Comments knew them when they sent. The token is
 * kept as its SHA-256 hash.
 */
export const commentSends = sqliteTable("vitehub_comment_sends", {
  id: text("id").primaryKey(),
  member: text("member").notNull(),
  subjectKind: text("subject_kind").notNull(),
  subjectId: text("subject_id").notNull(),
  page: text("page").notNull(),
  threads: text("threads").notNull(),
  /** The idempotency key of the delivery: a hash of the member, the threads, and their last messages. */
  key: text("key").notNull(),
  state: text("state", { enum: ["pending", "sent", "working", "done", "failed"] }).notNull(),
  /** The id of the Webhooks delivery. */
  delivery: text("delivery"),
  /** The member endpoint that the send went to. Later sends to the same endpoint keep its `thread`. */
  endpoint: text("endpoint"),
  /** The link of the agent's thread, such as `t3-thread://v2/<environmentId>/<threadId>`, when the agent gave one. */
  thread: text("thread"),
  error: text("error"),
  sender: text("sender").notNull(),
  tokenHash: text("token_hash"),
  tokenExpiresAt: integer("token_expires_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, table => [
  index("vitehub_comment_sends_member").on(table.member, table.createdAt),
  index("vitehub_comment_sends_subject").on(table.subjectKind, table.subjectId, table.createdAt),
  uniqueIndex("vitehub_comment_sends_live_key").on(table.key).where(sql`${table.state} <> 'failed'`),
])

/** The tables of Send, for a Database contribution. Comments adds them only when `defineComments({ send })` is on. */
export const commentSendsSchema = { commentSends }

/** `commentSendsSchema` as SQLite statements that are safe to run on every start. */
export const commentSendsTables: readonly string[] = [
  "CREATE TABLE IF NOT EXISTS `vitehub_comment_sends` (`id` text PRIMARY KEY NOT NULL, `member` text NOT NULL, `subject_kind` text NOT NULL, `subject_id` text NOT NULL, `page` text NOT NULL, `threads` text NOT NULL, `key` text NOT NULL, `state` text NOT NULL, `delivery` text, `endpoint` text, `thread` text, `error` text, `sender` text NOT NULL, `token_hash` text, `token_expires_at` integer, `created_at` integer NOT NULL, `updated_at` integer NOT NULL)",
  "CREATE INDEX IF NOT EXISTS `vitehub_comment_sends_member` ON `vitehub_comment_sends` (`member`,`created_at`)",
  "CREATE INDEX IF NOT EXISTS `vitehub_comment_sends_subject` ON `vitehub_comment_sends` (`subject_kind`,`subject_id`,`created_at`)",
  "CREATE UNIQUE INDEX IF NOT EXISTS `vitehub_comment_sends_live_key` ON `vitehub_comment_sends` (`key`) WHERE `state` <> 'failed'",
]
