import { describeCommentContext } from "../context.ts"
import { commentsPageScope } from "../page.ts"
import { installedComments } from "./plugin.ts"

import type { ViteHubConsoleRecord } from "@vite-hub/internal/console"

function excerpt(text: string): string {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > 80 ? `${line.slice(0, 79)}…` : line
}

/** The threads of the app as Console records: open threads first, each group newest activity first. It runs on each Console request. */
export async function readCommentsConsoleRecords(): Promise<ViteHubConsoleRecord[]> {
  const comments = installedComments()
  if (!comments) return []
  const [error, threads] = await comments.list({ scope: commentsPageScope, limit: 500 })
  if (error) return []
  const ordered = [...threads.filter(thread => thread.status === "open"), ...threads.filter(thread => thread.status !== "open")]
  return ordered.map((thread) => {
    const first = thread.comments[0]
    const author = (name: string, guest?: boolean) => guest ? `${name} (guest)` : name
    return {
      id: thread.id,
      cells: {
        comment: first ? excerpt(first.body) : "",
        page: `\`${thread.page}\``,
        author: author(thread.createdBy.name, thread.createdBy.guest),
        replies: String(Math.max(0, thread.comments.length - 1)),
        status: thread.status === "open" ? "Open" : "Resolved",
        updated: thread.updatedAt,
      },
      link: { href: `${thread.page}?vitehub=comments#comment-${thread.id}`, label: "Open on page" },
      activity: thread.comments.map(comment => ({ author: author(comment.author.name, comment.author.guest), at: comment.createdAt, text: comment.body })),
      fields: [
        { label: "Page", value: thread.page },
        ...(thread.anchor ? [{ label: "Anchor", value: thread.anchor.field ? `Content field ${thread.anchor.field}` : thread.anchor.label }] : []),
        ...describeCommentContext(thread.context),
        ...(thread.resolvedBy ? [{ label: "Resolved by", value: thread.resolvedBy.name }] : []),
      ],
    }
  })
}
