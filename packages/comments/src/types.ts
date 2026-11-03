import type { H3Event } from "h3"

import type { CommentsDefinition, CommentsUser } from "./operations-core/define.ts"
import type {
  CommentAnchor,
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

export interface CommentsIdentifyContext {
  event: H3Event
}

export interface DefineCommentsOptions extends CommentsDefinition {
  /** Resolves the user of a request. Without it, Comments reads the ViteHub Auth session. Return `null` for anonymous. */
  identify?: (context: CommentsIdentifyContext) => CommentsUser | null | undefined | Promise<CommentsUser | null | undefined>
  /** Name of the Database that stores comments. Defaults to the `default` Database, or the only one. */
  database?: string
  /** Posts threads to the pull request that the page previews. */
  forge?: CommentsForgeOptions
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
  mentions?: string[]
  attachments?: string[]
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
  | "COMMENTS_RESOLVED"
  | "COMMENTS_CONTENT_MISSING"
  | "COMMENTS_FIELD_INVALID"
  | "COMMENTS_FIELD_NOT_EDITABLE"
  | "COMMENTS_FIELD_FORBIDDEN"
  | "COMMENTS_FIELD_CONFLICT"
  | "COMMENTS_FIELD_LOCKED"
