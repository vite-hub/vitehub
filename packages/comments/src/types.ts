import type { ViteHubContext } from "@vite-hub/runtime"

import type { CommentsDefinition, CommentsUser } from "./operations-core/define.ts"
import type {
  CommentAnchor,
  CommentActor,
  CommentContext,
  CommentListCursor,
  CommentMetadata,
  CommentStatus,
  CommentSubject,
  CommentThread,
  CommentUser,
} from "./operations-core/types.ts"

export type * from "./operations-core/types.ts"
export type {
  CommentAction,
  CommentMentionEvent,
  CommentMessageEvent,
  CommentsAttachmentFile,
  CommentsAuthorize,
  CommentsAuthorizeContext,
  CommentsCanMentionContext,
  CommentsDefinition,
  CommentsGitHubAccess,
  CommentsPeople,
  CommentsRateLimit,
  CommentsReadAttachmentContext,
  CommentsStoreAttachmentContext,
  CommentSubjectDefinition,
  CommentsUser,
} from "./operations-core/define.ts"

export interface CommentsForgeTarget {
  repository: string
  pullRequest: number
}

/**
 * Posts each thread to the pull request of the build that served its page: one comment per message, and one summary
 * comment that lists every thread. Credentials come from Server Env: a GitHub App (`VITEHUB_GITHUB_APP_ID` with
 * `VITEHUB_GITHUB_PRIVATE_KEY`), else `VITEHUB_GITHUB_TOKEN`.
 */
export interface CommentsForgeOptions {
  /** Only GitHub for now. */
  provider: "github"
  /** `owner/name`. Default: the repository of the build that served the thread's page. */
  repository?: string
  /**
   * The pull request of a thread. Default: the one the build names, else the open pull request whose head is the
   * build's branch. Return `undefined` to keep the thread off GitHub.
   */
  pullRequest?: (thread: CommentThread) => number | undefined | Promise<number | undefined>
  /**
   * The GitHub token of the person who wrote a message, such as the user token of their GitHub sign-in, so the
   * comment posts as them. Without one, the GitHub App posts it with their name.
   */
  token?: (author: CommentUser) => string | undefined | Promise<string | undefined>
  /** The heading of the summary comment. Default `"Preview comments"`. */
  title?: string
  /** GitHub Enterprise API base. Default `https://api.github.com`. */
  apiUrl?: string
  fetch?: typeof fetch
}

/**
 * The request event of a Comments call: the Request of the Comments API, or the server event of an operation call.
 * Read the request, its cookies, and the platform bindings from `event["~standard"]`. `context` is the H3 event
 * context, when the call came through an H3 event.
 */
export type CommentsRequestEvent = ViteHubContext<{ context?: Record<string, unknown> }>

export interface CommentsIdentifyContext {
  event: CommentsRequestEvent
}

export interface CommentsPageContext {
  /** The page URL: the origin of the request and the normalized path, without query and hash. */
  url: URL
  event: CommentsRequestEvent
}

/** The subject of a page, and the version of the subject that new threads start on. */
export interface CommentsPageSubject extends CommentSubject {
  revision?: number
}

/** What `send.address` gets: the member who presses Send, and the subject of their page. */
export interface CommentSendAddressContext {
  user: CommentsUser
  subject: CommentSubject
}

/** What `send.payload` gets: one send, before Comments delivers it. */
export interface CommentSendPayloadContext {
  /** The id of the send, as `send` of the delivered body. */
  send: string
  /** The member who pressed Send. */
  user: CommentsUser
  /** The subject of the page that the member sent from. */
  subject: CommentSubject
  /** The threads of the send. `asks` and `quotes` split their ids. */
  threads: readonly CommentThread[]
  asks: readonly string[]
  quotes: readonly string[]
}

/** A JSON value, as the delivered body holds it. */
export type CommentSendData = string | number | boolean | null | CommentSendData[] | { [key: string]: CommentSendData }

/**
 * Send: a member hands the threads that wait for an answer to their own agent, such as a T3 Code thread. Each member
 * pairs their agent once, in the comment pill.
 */
export interface CommentSendOptions {
  /** Adds `data` to the delivered body, such as the id of a document that your own MCP reads. Default: `null`. */
  payload?: (context: CommentSendPayloadContext) => CommentSendData | Promise<CommentSendData>
  /**
   * The address of the agent that should get a send from this subject, such as the T3 thread link that wrote the
   * document. A member who paired an agent from that thread sends there; otherwise to the agent they paired last.
   * Default: none, so every send goes to the agent the member paired last.
   */
  address?: (context: CommentSendAddressContext) => string | null | undefined | Promise<string | null | undefined>
  /**
   * `false` sends no read token: the agent reads the threads through your own MCP server, as the member. Default: each
   * send carries a token that reads its threads, as the member, for 24 hours.
   */
  grant?: false
  /** The hosts that a paired agent URL may use. Default: `["relay.t3.codes"]`, the T3 Code relay. */
  hosts?: readonly string[]
}

export interface DefineCommentsOptions extends CommentsDefinition {
  /**
   * `true` turns on **Send** in the comment pill, for signed-in people who may write. It needs Webhooks and a SQLite
   * Database: ViteHub adds the `vitehub_comment_sends` tables and the member endpoints of Webhooks. See
   * https://vitehub.dev/docs/comments/send
   */
  send?: boolean | CommentSendOptions
  /** Resolves the user of a request. Without it, Comments reads the ViteHub Auth session. Return `null` for anonymous. */
  identify?: (context: CommentsIdentifyContext) => CommentsUser | null | undefined | Promise<CommentsUser | null | undefined>
  /** Name of the Database that stores comments. Defaults to the `default` Database, or the only one. */
  database?: string
  /** Posts threads to the pull request that the page previews. */
  forge?: CommentsForgeOptions
  /**
   * The subject that the overlay comments on for a page, such as `{ kind: "drop", id, revision }`. The server decides:
   * the overlay reads the subject from `/session`, and a new thread from the overlay must be on it. `authorize` still
   * runs on the subject. Return `null` or `undefined` for the default, `{ kind: "page", id: url.pathname }`.
   */
  page?: (context: CommentsPageContext) => CommentsPageSubject | null | undefined | Promise<CommentsPageSubject | null | undefined>
}

export interface ListCommentThreadsOptions {
  subject?: CommentSubject
  /** Only threads about this kind of subject, across all its ids. */
  subjectKind?: string
  /** An app path. The same as a `page` subject. */
  page?: string
  /** Only the threads of this numbering scope, such as `site`. */
  scope?: string
  status?: CommentStatus
  /** Only threads started on this version of the subject or an earlier one. */
  revision?: { lte: number }
  /** Newest activity first. Default 200, at most 500. */
  limit?: number
  /** Where the next page starts: the `updatedAt` and `id` of the last thread of the page before. */
  before?: CommentListCursor
}

export interface CreateCommentThreadInput {
  /** What the thread is about. Or set `page`. */
  subject?: CommentSubject
  /** An app path, for a thread on a page. The same as `subject: { kind: "page", id: page }`. */
  page?: string
  /** Default `{ kind: "page" }`. */
  anchor?: CommentAnchor
  context?: CommentContext
  metadata?: CommentMetadata
  /** The version of the subject, such as a document version. */
  revision?: number
  /** A retry key. A second create with the same key and author in the same scope returns the first thread. */
  requestId?: string
  body: string
  author: CommentUser
  /** Ids of the people that `body` names with `@`. */
  mentions?: string[]
  attachments?: string[]
}

export interface EditCommentInput {
  body: string
  /** Replaces the mentions. Default: none. */
  mentions?: string[]
}

export interface ReplyInput {
  body: string
  author: CommentUser
  /** The agent replying on behalf of the author. */
  actor?: CommentActor
  mentions?: string[]
  attachments?: string[]
  /** A retry key. A second reply with the same key and author in the same thread returns the first message. */
  requestId?: string
}

export interface FindCommentThreadInput {
  /** The subject that the create named. Or set `page`. */
  subject?: CommentSubject
  /** An app path, for a thread on a page. */
  page?: string
  requestId: string
}

export interface ReplyOptions {
  /** Reply to a resolved thread, and keep it resolved. Default `false`: the reply fails with `COMMENTS_RESOLVED`. */
  allowResolved?: boolean
}

/** Codes of the errors that Comments methods return in the `[error, data]` tuple. */
export type CommentsErrorCode =
  | "COMMENTS_NOT_INSTALLED"
  | "COMMENTS_NOT_FOUND"
  | "COMMENTS_INVALID_INPUT"
  | "COMMENTS_FORBIDDEN"
  | "COMMENTS_POLICY_MISSING"
  | "COMMENTS_RESOLVED"
  | "COMMENTS_CONTENT_MISSING"
  | "COMMENTS_FIELD_INVALID"
  | "COMMENTS_FIELD_NOT_EDITABLE"
  | "COMMENTS_FIELD_FORBIDDEN"
  | "COMMENTS_FIELD_CONFLICT"
  | "COMMENTS_FIELD_LOCKED"
