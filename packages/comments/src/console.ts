import type { ViteHubConsoleOperationSection } from "@vite-hub/internal/console"

/**
 * Console section for the comment inbox. It lists the result of `comments.list`, called with the Console user, so
 * `authorize` applies to each thread. A page thread links to `<page>?comment=<n>`.
 */
export const commentsConsoleSection: ViteHubConsoleOperationSection = {
  description: "Read the comment threads of the site and jump to the page.",
  icon: "i-lucide-message-square",
  id: "comments",
  label: "Comments",
  view: {
    columns: [
      { key: "n", label: "#" },
      { key: "subject.id", label: "Subject" },
      { key: "status", label: "Status" },
      { key: "author.name|author.id", label: "Author" },
      { key: "messages.0.body", label: "Comment", format: "excerpt" },
      { key: "updatedAt", label: "Updated", format: "datetime" },
    ],
    filters: [
      { id: "all", input: {}, label: "All" },
      { id: "open", input: { status: "open" }, label: "Open" },
      { id: "resolved", input: { status: "resolved" }, label: "Resolved" },
      { id: "mine", input: { mine: true }, label: "Mine" },
      { id: "mentions", input: { mentions: true }, label: "Mentions" },
    ],
    kind: "operation-view",
    link: { label: "Open page", template: "{subject.id:path}?comment={n}", when: { equals: "page", path: "subject.kind" } },
    notice: "The list comes from the comments.list operation with your sign-in, so it shows only the threads that authorize lets you read. Without an authorize policy nobody can read comments: add one to defineComments(). `vitehub comments list` lists the same threads.",
    operation: "comments.list",
    pagination: { limit: 200, cursor: { id: "id", updatedAt: "updatedAt" } },
  },
}
