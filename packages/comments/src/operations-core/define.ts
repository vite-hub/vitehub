import { commentsErrorDiagnostics } from "./errors.ts"
import type { CommentActor, CommentMessage, CommentMetadata, CommentSubject, CommentThread, CommentUser } from "./types.ts"

/**
 * - `read`: see threads, join the presence room of a page, and get `@` suggestions.
 * - `write`: start threads and reply. Signed-in authors also edit and delete their own messages.
 * - `resolve`: resolve and reopen.
 * - `delete`: delete the messages and threads of other people.
 */
export type CommentAction = "read" | "write" | "resolve" | "delete"

/** What GitHub says about a person who signed in to Comments with GitHub. */
export interface CommentsGitHubAccess {
  /** Their GitHub username. */
  login: string
  /** The repository of the build, `owner/name`, when Comments knows it. */
  repository?: string
  /** Whether they can push to `repository`. False when Comments does not know the repository. */
  write: boolean
}

/**
 * The user of a request, with the application fields that a policy reads, such as `role`. `null` for an anonymous
 * request. Stored authors keep only `id`, `name`, and `image`.
 */
export type CommentsUser = Record<string, unknown> & {
  id: string
  name?: string
  image?: string
  /** A guest that named itself in the browser. */
  guest?: boolean
  /** For a person who signed in to Comments with GitHub. */
  github?: CommentsGitHubAccess
}

export interface CommentsAuthorizeContext {
  /** The signed-in user, including application fields such as `role`, or null. */
  user: CommentsUser | null
  /** The Agent Actor when an agent acts for `user`. */
  actor?: CommentActor
  action: CommentAction
  /** The thread that the action is about. Not set for `create`, `list`, and `users`. */
  thread?: CommentThread
  /**
   * What the action is about: the subject of `thread`, the subject that `create` starts a thread on, or the subject
   * that a `list` filters by. Not set for a `list` with no filter and for `users`.
   */
  subject?: CommentSubject
}

/** Decides whether a person or an Agent may take an action. Return `true` to allow. */
export type CommentsAuthorize = (context: CommentsAuthorizeContext) => boolean | Promise<boolean>

/** A kind of subject that threads can be about. */
export interface CommentSubjectDefinition {
  kind: string
  /** The numbering scope of a subject id. `n` is unique inside a scope. */
  scope: (subjectId: string) => string
  /**
   * Whether a message on this subject may have no text, such as a suggestion that keeps its text in `metadata`. A
   * function gets the `metadata` of the thread. A message with attachments may always have no text. Default `false`.
   */
  emptyBody?: boolean | ((thread: { metadata?: CommentMetadata }) => boolean)
  /** The app path that opens a thread, such as `/docs/42?comment=3`. `onMention` passes it as `link`. */
  link?: (thread: CommentThread) => string | undefined
}

/** Where `@` finds people. */
export interface CommentsPeople {
  /**
   * People whose name contains `query`, with the fields that `canMention` reads. Comments returns only their `id`,
   * `name`, and `image`.
   */
  search: (query: string, limit: number) => Promise<CommentUser[]> | CommentUser[]
  /** The people with these ids, including fields that `authorize` reads. An id that is not a person is left out. */
  byIds: (ids: readonly string[]) => Promise<CommentUser[]> | CommentUser[]
}

export interface CommentsCanMentionContext {
  /** The person who writes the message. */
  user: CommentsUser | null
  /** The person that the message would mention. */
  person: CommentUser & Record<string, unknown>
  /** The thread of the message. Not set for a new thread. */
  thread?: CommentThread
  /** The subject of the thread, or of the new thread. */
  subject?: CommentSubject
}

export interface CommentMentionEvent {
  thread: CommentThread
  message: CommentMessage
  /** The people that this message mentions for the first time. */
  users: CommentUser[]
  /** The app path that opens the thread, when its subject has one, such as `/pricing?comment=3`. */
  link?: string
}

export interface CommentMessageEvent {
  thread: CommentThread
  message: CommentMessage
  /** The people that the message mentions. */
  mentions: CommentUser[]
}

/** A file to attach, after Comments checked its size and type. */
export interface CommentsAttachmentFile {
  name: string
  type: string
  size: number
  data: Uint8Array
}

export interface CommentsStoreAttachmentContext {
  user: CommentsUser | null
  subject?: CommentSubject
}

export interface CommentsDefinition {
  /**
   * Who may read, write, resolve, and delete. Return `true` to allow. Without it, see `defaultPolicy()`: everyone on
   * the development server; in a production build, people signed in with GitHub who can push to the repository, and
   * people that the Console admits to its Comments section. Nobody else until you set it.
   */
  authorize?: CommentsAuthorize
  /** Subject kinds in addition to `page` (scope `site`) and `content` (scope `site`). */
  subjects?: readonly CommentSubjectDefinition[]
  /**
   * Where `@` finds people. Without it: the users of ViteHub Auth when the app has Auth, else the people who wrote
   * earlier comments in threads that the writer may read.
   */
  people?: CommentsPeople
  /**
   * Whether `user` may mention `person` in a thread. Suggestions leave out the people it refuses, and a message that
   * mentions one fails. Default: `person` may read the thread.
   */
  canMention?: (context: CommentsCanMentionContext) => boolean | Promise<boolean>
  /**
   * Runs once for each saved message that mentions people for the first time, with those people. It runs after the
   * answer, through `waitUntil` where the host has it. A failure is logged and never fails the comment.
   */
  onMention?: (event: CommentMentionEvent) => void | Promise<void>
  /** Runs after each new thread and each reply saves, before the answer. Errors are logged, not returned. */
  onComment?: (event: CommentMessageEvent) => void | Promise<void>
  /**
   * Stores an uploaded file and returns its key, which messages keep in `attachments`. Without it, Comments stores the
   * file in the Blob store of the app under `comments/`.
   */
  storeAttachment?: (file: CommentsAttachmentFile, context: CommentsStoreAttachmentContext) => string | Promise<string>
}

const marker: unique symbol = Symbol.for("vitehub.comments.definition")

/** Marks a definition, so the build can check what `server/comments.ts` exports. */
export function markCommentsDefinition<T extends object>(definition: T): T {
  Object.defineProperty(definition, marker, { value: true })
  return definition
}

export function isCommentsDefinition(value: unknown): value is CommentsDefinition {
  return value !== null && Object(value) === value && Reflect.get(Object(value), marker) === true
}

/** Validate the imported application module before installing its runtime. */
export function validateCommentsDefinition(value: unknown, file: string): CommentsDefinition {
  if (!isCommentsDefinition(value)) throw commentsErrorDiagnostics.COMMENTS_B0002({ file })
  return value
}

/** A subject kind of your own, such as `drop`. */
export function defineCommentSubject(subject: CommentSubjectDefinition): CommentSubjectDefinition {
  return Object.freeze({ ...subject })
}

/** Subjects that exist without a definition. */
export const builtinCommentSubjects: readonly CommentSubjectDefinition[] = [
  defineCommentSubject({ kind: "page", scope: () => "site", link: thread => `${thread.subject.id}?comment=${thread.n}` }),
  defineCommentSubject({ kind: "content", scope: () => "site" }),
]

/** What the server checked about a request before the policy runs. */
export interface CommentsPolicyGate {
  /** Vite's serve command. The generated Nitro plugin records it; it never comes from `NODE_ENV`. */
  development?: boolean
  /**
   * The Console admitted the person to its Comments section before Comments ran: the comment operations (RPC, CLI,
   * MCP) and, in an app with the Console, the overlay API.
   */
  console?: boolean
}

/**
 * The policy without `authorize`, for every action. On the development server, everyone may, anonymous people as
 * guests. In a production build, only people that a sign-in already vetted: a person signed in with GitHub who can
 * push to the repository of the build, or a person that the Console admitted to its Comments section. Users of
 * ViteHub Auth or `identify` get nothing until `authorize` says who may, because any visitor may be able to sign up.
 */
export function defaultPolicy(user: CommentsUser | null, gate: CommentsPolicyGate = {}): boolean {
  if (user?.github) return user.github.write
  if (gate.development === true) return true
  return user !== null && gate.console === true
}

/**
 * Whether the default policy denied `user` only because `server/comments.ts` has no `authorize`: a signed-in person
 * in a production build that neither GitHub nor the Console vetted. The diagnostics then name the missing policy.
 */
export function deniedForMissingPolicy(definition: Pick<CommentsDefinition, "authorize">, user: CommentsUser | null, gate: CommentsPolicyGate = {}): boolean {
  return !definition.authorize && user !== null && user.guest !== true && !user.github && gate.development !== true && gate.console !== true
}
