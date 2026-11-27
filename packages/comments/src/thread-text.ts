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
  if (thread.resolvedBy) lines.push("", `Resolved by ${thread.resolvedActor ? `${thread.resolvedActor.name ?? thread.resolvedActor.id} for ` : ""}${commentPersonName(thread.resolvedBy)} at ${new Date(thread.resolvedAt ?? thread.updatedAt).toISOString()}`)
  return lines.join("\n")
}

/** At most `max` characters of `value`, flattened to one line and cut at a word, with `…` when cut. */
function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim()
  if (flat.length <= max) return flat
  const head = flat.slice(0, max - 1)
  const space = head.lastIndexOf(" ")
  return `${(space > max / 2 ? head.slice(0, space) : head).trimEnd()}…`
}

/** What the comment points at, in a few words: the element label, the quoted text, or the selector. */
export function commentAnchorLabel(anchor: CommentThread["anchor"]): string {
  switch (anchor.kind) {
    case "page":
      return "the whole page"
    case "element":
      return anchor.field ? `Content field ${anchor.field}` : anchor.label ? JSON.stringify(clip(anchor.label, 60)) : clip(anchor.selector, 60)
    case "text":
      return `the text ${JSON.stringify(clip(anchor.exact, 60))}`
    case "area":
      return `an area of ${clip(anchor.selector, 60)}`
    case "image":
      return `the image ${clip(anchor.selector, 60)}`
  }
}

/** The fields of a thread in a list, as JSON. */
export interface CommentThreadSummary {
  id: string
  n: number
  page: string
  status: CommentThread["status"]
  /** What the comment points at, in words, such as `"Buy now"`, `the text "per month"`, or `the whole page`. */
  anchor: string
  comment: string
  author: string
  replies: number
  /** The Vue components that render the element, outermost first. */
  components: string[]
  /** The last activity, in milliseconds since the epoch. */
  updatedAt: number
}

export function commentThreadSummary(thread: CommentThread): CommentThreadSummary {
  return {
    id: thread.id,
    n: thread.n,
    page: thread.subject.id,
    status: thread.status,
    anchor: commentAnchorLabel(thread.anchor),
    comment: thread.messages[0]?.body ?? "",
    author: thread.author.name ?? thread.author.id,
    replies: Math.max(0, thread.messages.length - 1),
    components: thread.context?.components?.map(component => component.name) ?? [],
    updatedAt: thread.updatedAt,
  }
}

/** A time to the minute in UTC, in ISO 8601, such as `2026-11-17T09:22Z`. */
function minute(time: number): string {
  return `${new Date(time).toISOString().slice(0, 16)}Z`
}

/**
 * One line per thread in a list: number, id, page, anchor, last activity, the start of the first comment, author,
 * replies, and the innermost Vue component. Outer components, such as the layout, repeat on every thread of a page;
 * comments_get_thread and comments.get give the whole chain with its files.
 */
export function commentThreadLine(thread: CommentThreadSummary): string {
  const component = thread.components.at(-1)
  return `- #${thread.n} ${thread.id} ${thread.page} on ${thread.anchor}, updated ${minute(thread.updatedAt)}: ${clip(thread.comment, 120)} (${thread.author}, ${thread.replies} replies${component ? `, in ${component}` : ""})`
}

/** What a list knows about why `authorize` or the default policy left threads out. */
export interface HiddenThreadsReason {
  /** The app defines `authorize`. */
  authorize: boolean
  /** The app defines `identify`. */
  identify: boolean
  /** The call has a user. */
  user: boolean
  /** The Console admitted the caller to its Comments section. */
  console: boolean
}

/** One sentence that says how many threads the policy hid from a list, and what likely hid them. Empty for none. */
export function hiddenThreadsNote(hidden: number, reason: HiddenThreadsReason): string {
  if (!hidden) return ""
  const policy = reason.authorize ? "`authorize`" : "The default policy"
  const count = `${hidden} thread${hidden === 1 ? "" : "s"}`
  if (reason.identify && !reason.user && reason.console) {
    return `${policy} hid ${count} from this caller. With \`identify\`, a Console call has no app user: allow Console callers in \`authorize\` with \`({ console }) => console\`.`
  }
  if (reason.identify && !reason.user) return `${policy} hid ${count} from this caller, because \`identify\` found no user for this call.`
  if (!reason.authorize) return `The default policy hid ${count} from this caller. Allow them with \`authorize\` in server/comments.ts.`
  return `\`authorize\` hid ${count} from this caller.`
}

/** The text of a list of threads, with a note when the policy hid some. */
export function commentThreadsText(threads: readonly CommentThreadSummary[], status: CommentThread["status"], note: string): string {
  if (!threads.length) return note ? `No ${status} threads that this caller may read. ${note}` : `No ${status} threads.`
  return [...threads.map(commentThreadLine), ...(note ? ["", note] : [])].join("\n")
}
