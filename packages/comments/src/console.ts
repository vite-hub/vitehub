import type { ViteHubConsoleRuntimeRecordTableSection } from "@vite-hub/internal/console"

/**
 * Console section for the comment inbox: every thread of the site, open threads first, read on each request. Each
 * page thread links to `<page>?comment=<n>`.
 */
export const commentsConsoleSection: ViteHubConsoleRuntimeRecordTableSection = {
  description: "Read the comment threads of the site and jump to the page.",
  icon: "i-lucide-message-square",
  id: "comments",
  label: "Comments",
  runtime: { export: "readCommentsConsoleRecords", module: "@vite-hub/comments/runtime/console" },
  view: {
    columns: [
      { key: "number", label: "#" },
      { key: "subject", label: "Subject" },
      { key: "status", label: "Status" },
      { key: "author", label: "Author" },
      { key: "comment", label: "Comment" },
      { key: "updated", label: "Updated" },
    ],
    kind: "record-table",
    notice: "Threads come from the Database on each request, open threads first. Filter the table by status or author. Anyone with access to this section sees every thread, whatever authorize says for the page. `vitehub comments list --status open` lists the same threads.",
  },
}
