import type { H3Event } from "h3"

/** The person who wrote a comment. The row keeps a copy, so the name stays when the Auth user changes. */
export interface CommentAuthor {
  id: string
  name: string
  image?: string
  /** True for a guest that named itself in the browser. Show the name, never trust it. */
  guest?: boolean
}

/** A person that a comment mentions with `@`. */
export interface CommentMention {
  id: string
  name: string
}

/**
 * Where a thread sits on its page. The overlay tries each hint in order and uses the first one it finds: the Content
 * field, the CSS path checked against the label, the label alone, then the page point.
 */
export interface CommentAnchor {
  /** The `data-content-field` address of the element or its closest ancestor, such as `about#hero.title`. */
  field?: string
  /** CSS path of the element, at most 10 levels, from its closest ancestor with an id or a Content field. */
  selector: string
  /** Tag and the first 40 characters of the element text, to check that `selector` still finds the same element. */
  label: string
  /** Position of the pin in the element box, in thousandths of its width and height. */
  x: number
  y: number
  /** Fallback position: thousandths of the document width, and CSS pixels from the document top. */
  page: { x: number, y: number }
  /** Viewport width when the pin was dropped. */
  viewport: { width: number }
}

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

/**
 * What a person saw when they started a thread, so a teammate or an Agent can find the code to change. The overlay
 * reads the page, the element, the Vue components, and the browser; the server adds the build.
 */
export interface CommentContext {
  /** The page URL without the comment mode query and the hash. */
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
  /** The commit and branch of the build that served the page, when the build could read them. */
  build?: { commit?: string, branch?: string }
}

export interface Comment {
  id: string
  threadId: string
  /** Plain text, at most 4,000 characters. */
  body: string
  mentions: CommentMention[]
  author: CommentAuthor
  /** ISO time. */
  createdAt: string
  editedAt: string | null
}

export type CommentThreadStatus = "open" | "resolved"

export interface CommentThread {
  id: string
  /** Normalized pathname of the page, such as `/pricing`. */
  page: string
  anchor: CommentAnchor
  /** Null for threads that server code created without it. */
  context: CommentContext | null
  status: CommentThreadStatus
  createdBy: CommentAuthor
  resolvedBy: CommentAuthor | null
  resolvedAt: string | null
  createdAt: string
  updatedAt: string
  /** Oldest first. The first comment opened the thread. */
  comments: Comment[]
}

/**
 * - `read`: see pins and threads, and join the page room.
 * - `comment`: start threads, reply, and delete own comments.
 * - `resolve`: resolve, reopen, and delete any thread.
 */
export type CommentsAction = "read" | "comment" | "resolve"

/** The user that `identify` or the ViteHub Auth session resolved. `null` for an anonymous request. */
export type CommentsUser = Record<string, unknown> & { id: string }

export interface CommentsAuthorizeContext {
  user: CommentsUser | null
  action: CommentsAction
  /** The thread the action changes. Undefined for reads and new threads. */
  thread?: CommentThread
}

export interface CommentsIdentifyContext {
  event: H3Event
}

export interface CommentsPeopleContext {
  /** Text after `@`, possibly empty. */
  query: string
  user: CommentsUser | null
}

export interface CommentCreatedEvent {
  thread: CommentThread
  comment: Comment
  /** People the comment mentions. */
  mentions: CommentMention[]
}

export interface DefineCommentsOptions {
  /**
   * Who may read, comment, and resolve. Return `false` to deny. Without it, any signed-in user may do everything and
   * anonymous requests may do nothing. Return `true` for `user: null` to let guests comment under a name they choose.
   */
  authorize?: (context: CommentsAuthorizeContext) => boolean | void | Promise<boolean | void>
  /** Resolves the user of a request. Without it, Comments reads the ViteHub Auth session. Return `null` for anonymous. */
  identify?: (context: CommentsIdentifyContext) => CommentsUser | null | undefined | Promise<CommentsUser | null | undefined>
  /** Name of the Database that stores comments. Defaults to the `default` Database, or the only one. */
  database?: string
  /** People that `@` suggests. Without it, the authors of earlier comments. */
  people?: (context: CommentsPeopleContext) => CommentMention[] | Promise<CommentMention[]>
  /** Runs after a comment saves, such as to notify mentioned people by Email. Errors are logged, not returned. */
  onComment?: (event: CommentCreatedEvent) => void | Promise<void>
}

export interface ListCommentThreadsOptions {
  /** Only the threads of this page. */
  page?: string
  status?: CommentThreadStatus
  /** Newest activity first. Default 200, at most 500. */
  limit?: number
}

export interface CreateCommentThreadInput {
  page: string
  anchor: CommentAnchor
  context?: CommentContext
  body: string
  author: CommentAuthor
  mentions?: CommentMention[]
}

export interface ReplyInput {
  body: string
  author: CommentAuthor
  mentions?: CommentMention[]
}

/** Codes of the errors that Comments methods return in the `[error, data]` tuple. */
export type CommentsErrorCode =
  | "COMMENTS_NOT_INSTALLED"
  | "COMMENTS_NOT_FOUND"
  | "COMMENTS_INVALID_INPUT"
  | "COMMENTS_FORBIDDEN"
  | "COMMENTS_RESOLVED"
  | "COMMENTS_CONTENT_MISSING"
  | "COMMENTS_FIELD_INVALID"
  | "COMMENTS_FIELD_NOT_EDITABLE"
  | "COMMENTS_FIELD_FORBIDDEN"
  | "COMMENTS_FIELD_CONFLICT"
  | "COMMENTS_FIELD_LOCKED"
