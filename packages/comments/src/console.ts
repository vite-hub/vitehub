import { ownModule } from "@vite-hub/internal/build/paths"
import { findCommentsEntry } from "./entry.ts"

import type { ViteHubConsoleRuntimeRecordTableSection } from "@vite-hub/internal/console"

/**
 * Console section for Comments: every thread with its first comment, page, author, replies, and status, open threads
 * first. People reply and resolve on the page itself, where the context is; each record links there. The
 * Console shows it when the app has `server/comments.ts`.
 */
export const commentsConsoleSection: ViteHubConsoleRuntimeRecordTableSection<{ projectRoot: string, serverDirs?: string[] }> = {
  entry: ({ projectRoot, serverDirs }) => findCommentsEntry(projectRoot, serverDirs),
  description: "Triage comments that the team left on the site's pages.",
  icon: "i-vitehub-comments",
  id: "comments",
  label: "Comments",
  runtime: { export: "readCommentsConsoleRecords", module: ownModule(import.meta.url, "runtime/console") },
  view: {
    columns: [
      { key: "comment", label: "Comment" },
      { key: "page", label: "Page" },
      { key: "author", label: "Author" },
      { key: "replies", label: "Replies" },
      { filter: true, key: "status", label: "Status" },
      { key: "updated", label: "Last activity" },
    ],
    kind: "record-table",
    notice: "People comment, reply, and resolve on the site's pages. Open threads come first. Server code reads the same threads with `comments.list()`.",
  },
}
