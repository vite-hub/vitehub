/** A person. The signed-in user and every author have this shape. */
export interface CommentUser {
  id: string
  /** Shown when there is one, else the `id`. */
  name?: string
  image?: string
}

/** The agent that wrote a comment on behalf of a user. */
export interface CommentActor {
  id: string
  name?: string
}

export type CommentStatus = "open" | "resolved"

/** What a thread is about. `page` takes an app path as `id`. Other kinds, such as `content`, name their own ids. */
export interface CommentSubject {
  kind: string
  id: string
}

/**
 * Every offset is in thousandths of the element box, so `500` is the middle.
 * An anchor with a rectangle keeps it inside the box: `x + width <= 1000`.
 */
export interface PageAnchor {
  kind: "page"
}

export interface ElementAnchor {
  kind: "element"
  selector: string
  x: number
  y: number
}

/** A W3C TextQuoteSelector inside the element that `selector` names. */
export interface TextAnchor {
  kind: "text"
  selector: string
  exact: string
  prefix: string
  suffix: string
}

export interface AreaAnchor {
  kind: "area"
  selector: string
  x: number
  y: number
  width: number
  height: number
}

/** A point on an image, or an area when `width` and `height` are set. */
export interface ImageAnchor {
  kind: "image"
  selector: string
  x: number
  y: number
  width?: number
  height?: number
}

export type CommentAnchor = PageAnchor | ElementAnchor | TextAnchor | AreaAnchor | ImageAnchor

/** One Markdown message. The first message of a thread is the comment. */
export interface CommentMessage {
  id: string
  threadId: string
  body: string
  author: CommentUser
  actor?: CommentActor
  /** Ids of the users mentioned in `body`. */
  mentions: string[]
  /** Blob keys. Always empty for now: attachments come with the upload operation. */
  attachments: string[]
  /** Milliseconds since the epoch. */
  createdAt: number
  editedAt?: number
}

export interface CommentThread {
  id: string
  /** The numbering scope. `n` is unique inside it. */
  scope: string
  /** The number that pins and `?comment=<n>` show. */
  n: number
  subject: CommentSubject
  anchor: CommentAnchor
  status: CommentStatus
  resolvedBy?: CommentUser
  resolvedAt?: number
  author: CommentUser
  actor?: CommentActor
  /** Oldest first. */
  messages: CommentMessage[]
  createdAt: number
  updatedAt: number
}

export interface CommentListQuery {
  subject?: CommentSubject
  /** An app path. The same as a `page` subject. */
  page?: string
  status?: CommentStatus
  /** Only threads that the signed-in user started. */
  mine?: boolean
  /** Only threads that mention the signed-in user. */
  mentions?: boolean
  /** Most threads in the answer. Default 200, at most 500. */
  limit?: number
  /** Where the next page starts: the `updatedAt` and `id` of the last thread of the page before. Threads come newest first. */
  before?: CommentListCursor
}

/** The position of a thread in a list: the list is ordered by `updatedAt`, then `id`, newest first. */
export interface CommentListCursor {
  updatedAt: number
  id: string
}

/** By id, or by number inside its scope, as `?comment=<n>` names it. */
export type CommentGetInput = { id: string } | { scope: string, n: number }

export interface CommentCreateInput {
  subject: CommentSubject
  anchor: CommentAnchor
  body: string
  mentions?: string[]
  attachments?: string[]
}

export interface CommentReplyInput {
  threadId: string
  body: string
  mentions?: string[]
  attachments?: string[]
}

export interface CommentEditInput {
  threadId: string
  messageId: string
  body: string
  mentions?: string[]
}

/** Without `messageId` the whole thread goes. Deleting the first message also deletes the thread. */
export interface CommentDeleteInput {
  threadId: string
  messageId?: string
}

export interface CommentStatusInput {
  threadId: string
}

export interface CommentUsersInput {
  query: string
  limit?: number
}

export type CommentEvent =
  | { type: "thread", thread: CommentThread }
  | { type: "deleted", threadId: string }
  // The transport lost its connection and has it again. The events in between are gone, so the client lists the threads again.
  | { type: "reconnected" }

/**
 * The seam between the browser and the server. Each method has the name and the input of one `comments.*` operation.
 * A mutation returns the thread as it is afterwards, and `delete` returns `null` when the thread is gone.
 */
export interface CommentsTransport {
  list: (query: CommentListQuery) => Promise<CommentThread[]>
  get: (input: CommentGetInput) => Promise<CommentThread | null>
  create: (input: CommentCreateInput) => Promise<CommentThread>
  reply: (input: CommentReplyInput) => Promise<CommentThread>
  edit: (input: CommentEditInput) => Promise<CommentThread>
  delete: (input: CommentDeleteInput) => Promise<CommentThread | null>
  resolve: (input: CommentStatusInput) => Promise<CommentThread>
  reopen: (input: CommentStatusInput) => Promise<CommentThread>
  users: (input: CommentUsersInput) => Promise<CommentUser[]>
  /** Live updates, such as Realtime. Without it the client refreshes when the window gets focus. */
  subscribe?: (listener: (event: CommentEvent) => void) => () => void
}
