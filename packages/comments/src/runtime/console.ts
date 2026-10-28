import { installedComments } from "./plugin.ts"

import type { ViteHubConsoleRecord } from "@vite-hub/internal/console"

function excerpt(text: string): string {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > 80 ? `${line.slice(0, 79)}…` : line
}

/** The threads of the app, newest activity first, as Console records. It runs on each Console request. */
export async function readCommentsConsoleRecords(): Promise<ViteHubConsoleRecord[]> {
  const comments = installedComments()
  if (!comments) return []
  const [error, threads] = await comments.list({ limit: 500 })
  if (error) return []
  return threads.map((thread) => {
    const first = thread.comments[0]
    const link = `${thread.page}?comments#comment-${thread.id}`
    return {
      id: thread.id,
      cells: {
        page: thread.page,
        comment: first ? excerpt(first.body) : "",
        author: thread.createdBy.guest ? `${thread.createdBy.name} (guest)` : thread.createdBy.name,
        replies: String(Math.max(0, thread.comments.length - 1)),
        status: thread.status === "open" ? "Open" : "Resolved",
        updated: thread.updatedAt.slice(0, 16).replace("T", " "),
      },
      fields: [
        { label: "Open on page", value: link },
        { label: "Anchor", value: thread.anchor.field ? `Content field ${thread.anchor.field}` : thread.anchor.label },
        ...thread.comments.map(comment => ({ label: comment.author.name, value: comment.body })),
        ...(thread.resolvedBy ? [{ label: "Resolved by", value: thread.resolvedBy.name }] : []),
      ],
    }
  })
}
