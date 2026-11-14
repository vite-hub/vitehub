import { describeCommentContext } from "./context.ts"

import type { CommentThread, CommentUser } from "./types.ts"

export function commentPersonName(person: CommentUser): string {
  return `${person.name ?? person.id}${person.guest ? " (guest)" : ""}`
}

/** Thousandths of an element box as a percentage, such as `97.3%`. */
const share = (value: number) => `${Number((value / 10).toFixed(1))}%`

/** What the comment points at, in words: the element, the quoted text, or the part of the element box it marked. */
function describeAnchor(anchor: CommentThread["anchor"]): string {
  switch (anchor.kind) {
    case "page":
      return "Anchor: the whole page"
    case "element":
      return `Anchor: ${anchor.field ? `Content field ${anchor.field}` : anchor.label ?? anchor.selector} (${anchor.selector})`
    case "text":
      return `Anchor: the text ${JSON.stringify(anchor.exact)} in ${anchor.selector}`
    case "area":
      return `Anchor: an area of ${anchor.selector}, ${share(anchor.width)} wide and ${share(anchor.height)} high, from ${share(anchor.x)} left and ${share(anchor.y)} top of its box`
    case "image":
      return anchor.width && anchor.height
        ? `Anchor: an area of the image ${anchor.selector}, ${share(anchor.width)} wide and ${share(anchor.height)} high, from ${share(anchor.x)} left and ${share(anchor.y)} top`
        : `Anchor: a point on the image ${anchor.selector}, ${share(anchor.x)} from the left and ${share(anchor.y)} from the top`
  }
}

/** One thread as text an Agent reads: where it is, what the person saw, and the conversation with its attachments. */
export function describeCommentThread(thread: CommentThread): string {
  const lines = [
    `Thread #${thread.n} ${thread.id} (${thread.status}) on ${thread.subject.id}`,
    describeAnchor(thread.anchor),
    ...describeCommentContext(thread.context ?? null).map(field => `${field.label}: ${field.value}`),
    "",
    ...thread.messages.flatMap(message => [
      `${commentPersonName(message.author)}, ${new Date(message.createdAt).toISOString()}: ${message.body}`,
      ...(message.attachments.length ? [`Attachments: ${message.attachments.join(", ")}`] : []),
    ]),
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

/** One line per thread in a list: number, id, page, the start of the first comment, author, replies, and Vue components. */
export function commentThreadLine(thread: CommentThreadSummary): string {
  return `- #${thread.n} ${thread.id} ${thread.page}: ${thread.comment.slice(0, 120)} (${thread.author}, ${thread.replies} replies${thread.components.length ? `, in ${thread.components.join(" › ")}` : ""})`
}
