import { describeCommentContext } from "../context.ts"
import { commentsPageScope } from "../page.ts"
import { installedComments } from "./plugin.ts"

import type { ViteHubConsoleRecord } from "@vite-hub/internal/console"
import type { CommentUser } from "../types.ts"

function excerpt(text: string): string {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > 80 ? `${line.slice(0, 79)}…` : line
}

/** The threads of the app as Console records: open threads first, each group newest activity first. It runs on each Console request. */
export async function readCommentsConsoleRecords(): Promise<ViteHubConsoleRecord[]> {
  const comments = installedComments()
  if (!comments) return []
  const [error, listed] = await comments.list({ scope: commentsPageScope, subjectKind: "page", limit: 500 })
  if (error) return []
  const threads = listed.filter(thread => thread.subject.kind === "page")
  const ordered = [...threads.filter(thread => thread.status === "open"), ...threads.filter(thread => thread.status !== "open")]
  const author = (person: CommentUser) => `${person.name ?? person.id}${person.guest ? " (guest)" : ""}`
  return ordered.map((thread) => {
    const first = thread.messages[0]
    const page = thread.subject.id
    const { anchor } = thread
    return {
      id: thread.id,
      cells: {
        comment: first ? excerpt(first.body) : "",
        page: `\`${page}\``,
        author: author(thread.author),
        replies: String(Math.max(0, thread.messages.length - 1)),
        status: thread.status === "open" ? "Open" : "Resolved",
        updated: new Date(thread.updatedAt).toISOString(),
      },
      link: { href: `${page}?vitehub=comments#comment-${thread.id}`, label: "Open on page" },
      activity: thread.messages.map(message => ({ author: author(message.author), at: new Date(message.createdAt).toISOString(), text: message.body })),
      fields: [
        { label: "Page", value: page },
        ...(anchor.kind === "element" ? [{ label: "Anchor", value: anchor.field ? `Content field ${anchor.field}` : anchor.label ?? anchor.selector }] : []),
        ...describeCommentContext(thread.context ?? null),
        ...(thread.resolvedBy ? [{ label: "Resolved by", value: author(thread.resolvedBy) }] : []),
      ],
    }
  })
}
