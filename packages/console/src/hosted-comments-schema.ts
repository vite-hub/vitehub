import { commentsSqliteTables } from "vite-hub/comments/database"

import { consoleProjects } from "./projects.ts"

/**
 * The hosted Comments of the linked projects: the Comments tables with `console_comment` names, and the project id in
 * `scope`. Unlinking a project deletes its threads and counters, and the trigger of the migration deletes their messages.
 */
export const consoleHostedCommentTables = commentsSqliteTables({ prefix: "console_comment", scope: () => consoleProjects.id })

export const consoleHostedCommentsSchema = {
  consoleCommentThreads: consoleHostedCommentTables.commentThreads,
  consoleCommentMessages: consoleHostedCommentTables.commentMessages,
  consoleCommentCounters: consoleHostedCommentTables.commentCounters,
}
