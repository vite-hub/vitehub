/**
 * The tables of `commentsSchema` and `commentsPostgresSchema`: each schema key and its SQL name. The Comments
 * contribution gives them to the Database, so resolving the Vite config loads neither the schema nor drizzle-orm. A
 * test keeps them equal to both schemas.
 */
export const commentsTableNames: Readonly<Record<string, string>> = {
  vitehubCommentThreads: "vitehub_comment_threads",
  vitehubCommentMessages: "vitehub_comment_messages",
  vitehubCommentCounters: "vitehub_comment_counters",
  vitehubCommentForge: "vitehub_comment_forge",
}

/** The tables of `commentSendsSchema`: each schema key and its SQL name. Comments adds them when `send` is on. */
export const commentSendsTableNames: Readonly<Record<string, string>> = {
  commentSends: "vitehub_comment_sends",
  commentSendCodes: "vitehub_comment_send_codes",
}
