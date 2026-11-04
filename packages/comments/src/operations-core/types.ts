/** A person. The signed-in user and every author have this shape. */
export interface CommentUser {
  id: string
  /** Shown when there is one, else the `id`. */
  name?: string
  image?: string
  /**
   * True for a guest that named itself in the browser. Its id starts with `guest:`. Show the name, never trust it:
   * a guest id never proves who wrote a message.
   */
  guest?: boolean
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
  /** The `data-content-field` address of the element or its closest ancestor, such as `about#hero.title`. */
  field?: string
  /** Tag and the first 40 characters of the element text, to check that `selector` still finds the same element. */
  label?: string
  /** Fallback position when the element is gone: thousandths of the document width, and CSS pixels from the document top. */
  page?: { x: number, y: number }
  /** Viewport width when the pin was dropped. */
  viewport?: { width: number }
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

/**
 * Fields that app code keeps on a thread, such as where its own UI anchors it: at most 50 keys of at most 64
 * characters, and strings of at most 4,000 characters.
 */
export type CommentMetadata = Record<string, string | number | boolean | null>

/** A Vue component that renders the element of a thread. */
export interface CommentComponent {
  /** The component name, such as `PricingCard`. `<script setup>` components get the name of their file. */
  name: string
  /**
   * Source files that may define it, relative to the project root. Production builds keep only the name, so a
   * name that two files share, such as `index`, gets both.
   */
  files?: string[]
}

/** The build that served a page: what the CI or host told the build, else Git. */
export interface CommentBuild {
  commit?: string
  branch?: string
  /** The GitHub repository, as `owner/name`. */
  repository?: string
  /** The pull request that the build previews, when the host names it. */
  pullRequest?: number
}

/**
 * What a person saw when they started a thread on a page, so a teammate or an Agent can find the code to change. The
 * overlay reads the page, the element, the Vue components, and the browser; the server adds the build.
 */
export interface CommentContext {
  /** The page origin and pathname, without credentials, query parameters, or a hash. */
  url: string
  title?: string
  /** The Vue Router route pattern, such as `/blog/:id(.*)*`. */
  route?: string
  element?: {
    tag: string
    id?: string
    /** `data-testid`, `data-test`, or `data-cy` of the element or its closest ancestor. */
    testId?: string
    /** The `role` attribute, or the role of the tag, such as `button` or `heading`. */
    role?: string
    /** `aria-label`, `alt`, `title`, or the first 120 characters of the text. */
    name?: string
    classes?: string[]
  }
  /** Outermost first. Empty on pages that Vue does not render. */
  components?: CommentComponent[]
  environment?: {
    viewport: { width: number, height: number }
    devicePixelRatio: number
    userAgent: string
    language?: string
    colorScheme?: "light" | "dark"
    timeZone?: string
  }
  /** The build that served the page, when the build could read it. */
  build?: CommentBuild
}

/**
 * Where a thread sits on its pull request, when `defineComments({ forge })` posts it.
 * - `posted`: on the pull request.
 * - `pending`: being posted.
 * - `failed`: the forge refused it; the next change, or `comments.sync()`, tries again.
 */
export interface CommentForgeLink {
  repository: string
  pullRequest: number
  state: "posted" | "pending" | "failed"
  /** The comment that holds the thread's first message. */
  url?: string
  /** Why the forge refused it. */
  error?: string
  /** `author` when it posted with the person's own GitHub token, `app` when the GitHub App posted it for them. */
  postedAs?: "author" | "app"
}

/** One Markdown message. The first message of a thread is the comment. */
export interface CommentMessage {
  id: string
  threadId: string
  body: string
  author: CommentUser
  actor?: CommentActor
  /** Ids of the users mentioned in `body`. */
  mentions: string[]
  /** Keys of the files that `comments.upload` stored, or that app code stored itself. */
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
  /** Fields that app code keeps on the thread. */
  metadata?: CommentMetadata
  /** What the person saw on the page, for threads that the overlay started. */
  context?: CommentContext
  /** The version of the subject that the thread was started on, such as a document version. */
  revision?: number
  /** The pull request comment of the thread, when `defineComments({ forge })` posts threads. */
  forge?: CommentForgeLink | null
  createdAt: number
  updatedAt: number
}

export interface CommentListQuery {
  subject?: CommentSubject
  /** Only threads about this kind of subject, across all its ids. */
  subjectKind?: string
  /** An app path. The same as a `page` subject. */
  page?: string
  status?: CommentStatus
  /** Only threads that the signed-in user started. */
  mine?: boolean
  /** Only threads that mention the signed-in user. */
  mentions?: boolean
  /** Only threads started on this version of the subject or an earlier one. Threads without a `revision` are left out. */
  revision?: { lte: number }
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
  metadata?: CommentMetadata
  /** The version of the subject, such as a document version. A whole number from 0. */
  revision?: number
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
  /** The thread that the mention goes in. Suggestions leave out the people that may not be mentioned there. */
  threadId?: string
  /** The subject of a new thread, when there is no thread yet. */
  subject?: CommentSubject
}

export interface CommentUploadInput {
  /** The file name, such as `screenshot.png`. */
  name: string
  /** The media type. See the limits for the types that Comments takes. */
  type: string
  /** The file content, Base64-encoded. */
  data: string
  /** The subject of the thread that the file goes in. */
  subject?: CommentSubject
}

/** A stored file. Put its `key` in `attachments` of `create` or `reply`. */
export interface CommentAttachment {
  key: string
  name: string
  type: string
  /** Bytes. */
  size: number
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
  /** Whether the server accepts attachment keys. Defaults to true for custom transports. */
  supportsAttachments?: boolean
  list: (query: CommentListQuery) => Promise<CommentThread[]>
  get: (input: CommentGetInput) => Promise<CommentThread | null>
  create: (input: CommentCreateInput) => Promise<CommentThread>
  reply: (input: CommentReplyInput) => Promise<CommentThread>
  edit: (input: CommentEditInput) => Promise<CommentThread>
  delete: (input: CommentDeleteInput) => Promise<CommentThread | null>
  resolve: (input: CommentStatusInput) => Promise<CommentThread>
  reopen: (input: CommentStatusInput) => Promise<CommentThread>
  users: (input: CommentUsersInput) => Promise<CommentUser[]>
  /** Stores a file for `attachments`. Transports without it cannot attach files. */
  upload?: (input: CommentUploadInput) => Promise<CommentAttachment>
  /** Live updates, such as Realtime. Without it the client refreshes when the window gets focus. */
  subscribe?: (listener: (event: CommentEvent) => void) => () => void
}
