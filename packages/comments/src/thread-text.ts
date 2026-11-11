import { describeCommentContext } from "./context.ts"

import type { CommentThread, CommentUser } from "./types.ts"

export function commentPersonName(person: CommentUser): string {
  return `${person.name ?? person.id}${person.guest ? " (guest)" : ""}`
}

/** One thread as text an Agent reads: where it is, what the person saw, and the conversation. */
export function describeCommentThread(thread: CommentThread): string {
  const lines = [
    `Thread #${thread.n} ${thread.id} (${thread.status}) on ${thread.subject.id}`,
    ...(thread.anchor.kind === "element" ? [`Anchor: ${thread.anchor.field ? `Content field ${thread.anchor.field}` : thread.anchor.label ?? thread.anchor.selector} (${thread.anchor.selector})`] : []),
    ...describeCommentContext(thread.context ?? null).map(field => `${field.label}: ${field.value}`),
    "",
    ...thread.messages.map(message => `${commentPersonName(message.author)}, ${new Date(message.createdAt).toISOString()}: ${message.body}`),
  ]
  if (thread.resolvedBy) lines.push("", `Resolved by ${commentPersonName(thread.resolvedBy)} at ${new Date(thread.resolvedAt ?? thread.updatedAt).toISOString()}`)
  return lines.join("\n")
}

/** The fields of a thread in a list, as JSON. */
export interface CommentThreadSummary {
  id: string
  n: number
  page: string
  status: CommentThread["status"]
  comment: string
  author: string
  replies: number
  components: string[]
  updatedAt: number
}

export function commentThreadSummary(thread: CommentThread): CommentThreadSummary {
  return {
    id: thread.id,
    n: thread.n,
    page: thread.subject.id,
    status: thread.status,
    comment: thread.messages[0]?.body ?? "",
    author: thread.author.name ?? thread.author.id,
    replies: Math.max(0, thread.messages.length - 1),
    components: thread.context?.components?.map(component => component.name) ?? [],
    updatedAt: thread.updatedAt,
  }
}

/** One line per thread in a list: id, page, the start of the first comment, author, replies, and Vue components. */
export function commentThreadLine(thread: CommentThreadSummary): string {
  return `- ${thread.id} ${thread.page}: ${thread.comment.slice(0, 120)} (${thread.author}, ${thread.replies} replies${thread.components.length ? `, in ${thread.components.join(" › ")}` : ""})`
}
