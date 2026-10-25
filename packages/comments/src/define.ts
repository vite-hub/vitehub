import type { CommentActor, CommentMessage, CommentThread, CommentUser } from "./types.ts"

export type CommentAction = "read" | "write" | "resolve" | "delete"

export interface CommentsAuthorizeContext {
  /** The signed-in user, or null. */
  user: CommentUser | null
  /** The Agent Actor when an agent acts for `user`. */
  actor?: CommentActor
  action: CommentAction
  /** The thread that the action is about. Not set for `create`, `list`, and `users`. */
  thread?: CommentThread
}

/** Decides whether a person or an Agent may take an action. Comments are private: without it, nobody can read. */
export type CommentsAuthorize = (context: CommentsAuthorizeContext) => boolean | Promise<boolean>

/** A kind of subject that threads can be about. */
export interface CommentSubjectDefinition {
  kind: string
  /** The numbering scope of a subject id. `n` is unique inside a scope. */
  scope: (subjectId: string) => string
}

export interface CommentMentionEvent {
  thread: CommentThread
  message: CommentMessage
  /** The users that this message mentions for the first time. */
  mentioned: CommentUser[]
}

export interface CommentsDefinition {
  authorize?: CommentsAuthorize
  /** Subject kinds in addition to `page` (scope `site`) and `content` (scope `site`). */
  subjects?: readonly CommentSubjectDefinition[]
  /** Runs after a message that mentions someone is saved. A failure is logged and never fails the comment. */
  onMention?: (event: CommentMentionEvent) => void | Promise<void>
}

const marker: unique symbol = Symbol.for("vitehub.comments.definition")

/** The definition that `server/comments.ts` default-exports. */
export function defineComments(definition: CommentsDefinition = {}): CommentsDefinition {
  return Object.freeze({ ...definition, [marker]: true })
}

export function isCommentsDefinition(value: unknown): value is CommentsDefinition {
  return value !== null && Object(value) === value && Reflect.get(Object(value), marker) === true
}

/** A subject kind of your own, such as `drop`. */
export function defineCommentSubject(subject: CommentSubjectDefinition): CommentSubjectDefinition {
  return Object.freeze({ ...subject })
}

/** Subjects that exist without a definition. */
export const builtinCommentSubjects: readonly CommentSubjectDefinition[] = [
  defineCommentSubject({ kind: "page", scope: () => "site" }),
  defineCommentSubject({ kind: "content", scope: () => "site" }),
]
