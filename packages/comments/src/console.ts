import { findCommentsEntry } from "./entry.ts"

import type { ViteHubConsoleRuntimeRecordTableSection } from "@vite-hub/internal/console"

/**
 * Console section for Comments: every thread with its page, first comment, author, replies, and status. People reply
 * and resolve on the page itself, where the context is; each record links there in comment mode. The Console shows it
 * when the app has `server/comments.ts`.
 */
export const commentsConsoleSection: ViteHubConsoleRuntimeRecordTableSection<{ projectRoot: string, serverDirs?: string[] }> = {
  entry: ({ projectRoot, serverDirs }) => findCommentsEntry(projectRoot, serverDirs),
  description: "Triage comments that the team left on the site's pages.",
  icon: "i-lucide-message-square-text",
  id: "comments",
  label: "Comments",
  runtime: { export: "readCommentsConsoleRecords", module: "@vite-hub/comments/runtime/console" },
  view: {
    columns: [
      { key: "page", label: "Page" },
      { key: "comment", label: "Comment" },
      { key: "author", label: "Author" },
      { key: "replies", label: "Replies" },
      { key: "status", label: "Status" },
      { key: "updated", label: "Updated" },
    ],
    kind: "record-table",
    notice: "Threads come from the Comments Database on each request. Open any page with `?comments` to comment, reply, and resolve on the page. `comments.list()` in server code reads the same threads.",
  },
}
