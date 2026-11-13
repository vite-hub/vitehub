import { markCommentsDefinition } from "./operations-core/define.ts"
import { can, createThread, editMessage, replyToThread, scopeOf, suggest } from "./operations-core/service.ts"
import { commentsErrors } from "./errors.ts"
import { pendingKey, runtimeOf, runtimes } from "./installed.ts"
import { normalizeCommentPage } from "./page.ts"

import type { Result } from "@vite-hub/runtime"
import type { CommentAction, CommentsPolicyGate, CommentsUser } from "./operations-core/define.ts"
import type { CommentsRuntime } from "./operations-core/service.ts"
import type {
  CommentMessage,
  CommentSubject,
  CommentThread,
  CommentUser,
  CreateCommentThreadInput,
  CommentsErrorCode,
  DefineCommentsOptions,
  EditCommentInput,
  ListCommentThreadsOptions,
  ReplyInput,
  ReplyOptions,
} from "./types.ts"

export { describeCommentContext } from "./context.ts"
export { commentRoom, commentsPageScope, commentsRealtimeDefinition, commentsRoute, normalizeCommentPage } from "./page.ts"
export { builtinCommentSubjects, commentsRoleAllows, defaultPolicy, defineCommentSubject } from "./operations-core/define.ts"
export type { CommentsPolicyGate } from "./operations-core/define.ts"
export { commentsErrorDiagnostics } from "./client-errors.ts"
export type * from "./types.ts"
export { commentsRuntimeOf, resolveCommentsRuntime } from "./installed.ts"

type Codes<T extends CommentsErrorCode> = T

/** The Comments runtime of an app: the export of `server/comments.ts`. */
export interface Comments {
  readonly options: DefineCommentsOptions
  /** Threads with their messages, newest activity first. */
  list(options?: ListCommentThreadsOptions): Promise<Result<CommentThread[], Codes<"COMMENTS_NOT_INSTALLED" | "COMMENTS_INVALID_INPUT">>>
  get(id: string): Promise<Result<CommentThread, Codes<"COMMENTS_NOT_INSTALLED" | "COMMENTS_NOT_FOUND">>>
  /** The thread that holds a message, for a route that has only the message id. */
  getByMessage(messageId: string): Promise<Result<CommentThread, Codes<"COMMENTS_NOT_INSTALLED" | "COMMENTS_NOT_FOUND">>>
  /** Thread `#n` of a numbering scope, such as `site`. */
  getByNumber(scope: string, n: number): Promise<Result<CommentThread, Codes<"COMMENTS_NOT_INSTALLED" | "COMMENTS_NOT_FOUND">>>
  /** Starts a thread with its first message, numbered next in the scope of its subject. Runs `onComment`. */
  create(input: CreateCommentThreadInput): Promise<Result<CommentThread, Codes<"COMMENTS_NOT_INSTALLED" | "COMMENTS_INVALID_INPUT">>>
  /** Adds a message to an open thread. Runs `onComment`. */
  reply(threadId: string, input: ReplyInput, options?: ReplyOptions): Promise<Result<CommentMessage, Codes<"COMMENTS_NOT_INSTALLED" | "COMMENTS_NOT_FOUND" | "COMMENTS_INVALID_INPUT" | "COMMENTS_RESOLVED">>>
  resolve(threadId: string, options: { by: CommentUser }): Promise<Result<CommentThread, Codes<"COMMENTS_NOT_INSTALLED" | "COMMENTS_NOT_FOUND">>>
  reopen(threadId: string): Promise<Result<CommentThread, Codes<"COMMENTS_NOT_INSTALLED" | "COMMENTS_NOT_FOUND">>>
  /** Deletes a thread and all its messages. */
  remove(threadId: string): Promise<Result<void, Codes<"COMMENTS_NOT_INSTALLED" | "COMMENTS_NOT_FOUND">>>
  /** Deletes one message. Deleting the first message deletes the thread. */
  removeMessage(messageId: string): Promise<Result<void, Codes<"COMMENTS_NOT_INSTALLED" | "COMMENTS_NOT_FOUND">>>
  /** Changes the text of a message and sets `editedAt`. */
  edit(messageId: string, input: EditCommentInput): Promise<Result<CommentMessage, Codes<"COMMENTS_NOT_INSTALLED" | "COMMENTS_NOT_FOUND" | "COMMENTS_INVALID_INPUT">>>
  /** Deletes every thread of a numbering scope, such as when app code deletes the document that the scope names. */
  removeScope(scope: string): Promise<Result<{ removed: number }, Codes<"COMMENTS_NOT_INSTALLED">>>
  /**
   * Whether the `authorize` policy allows an action. Without a policy, see `defaultPolicy()`. `gate` says what your
   * server checked before, such as Console section access; a route of your own usually passes nothing.
   */
  can(context: { user: CommentsUser | null, action: CommentAction, thread?: CommentThread, subject?: CommentSubject }, gate?: CommentsPolicyGate): Promise<boolean>
  /** People that `@` suggests to `user`, at most 20: `people`, else Auth, else the authors of threads that `user` may read. */
  people(context: { query: string, user: CommentsUser | null, thread?: CommentThread, subject?: CommentSubject, limit?: number, gate?: CommentsPolicyGate }): Promise<Result<CommentUser[], Codes<"COMMENTS_NOT_INSTALLED">>>
  /**
   * With `forge`: brings the thread's pull request comments in line with the thread now, and posts what failed
   * before. Every change starts this on its own; `flush()` waits for it.
   */
  sync(threadId: string): Promise<void>
  /** Waits for the pull request syncs and `onMention` calls that earlier changes started. On Cloudflare, pass it to `waitUntil`. */
  flush(): Promise<void>
}

/** A thread that someone deleted during the change: the store reads it again and finds nothing. */
function gone(error: unknown): undefined {
  if (error instanceof Error && Reflect.get(error, "code") === "COMMENTS_R0002") return undefined
  throw error
}

/** Diagnostics of the shared core, as the `[error, data]` codes of the server API. */
function resultError(error: unknown, id: string): ReturnType<typeof commentsErrors.COMMENTS_NOT_FOUND> | ReturnType<typeof commentsErrors.COMMENTS_INVALID_INPUT> | ReturnType<typeof commentsErrors.COMMENTS_RESOLVED> {
  const code = error instanceof Error ? Reflect.get(error, "code") : undefined
  if (code === "COMMENTS_R0002" || code === "COMMENTS_R0003") return commentsErrors.COMMENTS_NOT_FOUND({ id })
  if (code === "COMMENTS_R0016") return commentsErrors.COMMENTS_RESOLVED()
  if (typeof code === "string" && ["COMMENTS_R0005", "COMMENTS_R0007", "COMMENTS_R0008", "COMMENTS_R0017", "COMMENTS_R0018", "COMMENTS_R0022"].includes(code)) {
    return commentsErrors.COMMENTS_INVALID_INPUT({ issue: error instanceof Error ? error.message : String(error) })
  }
  throw error
}

/** Defines Comments for the app: the access policy, the people, the hooks, and the trusted server API. */
export function defineComments(options: DefineCommentsOptions = {}): Comments {
  const pending = new Set<Promise<unknown>>()
  const runtime = () => runtimeOf(comments)
  const notInstalled = (): [ReturnType<typeof commentsErrors.COMMENTS_NOT_INSTALLED>, undefined] => [commentsErrors.COMMENTS_NOT_INSTALLED(), undefined]
  const notFound = (id: string): [ReturnType<typeof commentsErrors.COMMENTS_NOT_FOUND>, undefined] => [commentsErrors.COMMENTS_NOT_FOUND({ id }), undefined]

  async function withForge(current: CommentsRuntime, threads: CommentThread[]): Promise<CommentThread[]> {
    return current.forge ? await current.forge.attach(threads) : threads
  }

  async function one(current: CommentsRuntime, found: CommentThread | null, id: string): Promise<Result<CommentThread, "COMMENTS_NOT_FOUND">> {
    return found ? [undefined, (await withForge(current, [found]))[0]!] : notFound(id)
  }

  const comments: Comments = {
    options,
    async list(query = {}) {
      const current = await runtime()
      if (!current) return notInstalled()
      const limit = Math.min(Math.max(Math.trunc(query.limit ?? 200), 1), 500)
      const { page, ...rest } = query
      const subject = query.subject ?? (page === undefined ? undefined : { id: normalizeCommentPage(page), kind: "page" })
      try {
        return [undefined, await withForge(current, await current.store.list({ ...rest, ...(subject ? { subject } : {}), limit }))]
      }
      catch (error) {
        // Tables that a migration must move first are not an input problem.
        if (Reflect.get(Object(error), "code") === "COMMENTS_R0019") throw error
        return [commentsErrors.COMMENTS_INVALID_INPUT({ issue: error instanceof Error ? error.message : String(error) }), undefined]
      }
    },
    async get(id) {
      const current = await runtime()
      if (!current) return notInstalled()
      return one(current, await current.store.getById(id), id)
    },
    async getByMessage(messageId) {
      const current = await runtime()
      if (!current) return notInstalled()
      return one(current, await current.store.getByMessage(messageId), messageId)
    },
    async getByNumber(scope, n) {
      const current = await runtime()
      if (!current) return notInstalled()
      return one(current, await current.store.getByNumber(scope, n), `${scope}#${n}`)
    },
    async create({ page, subject, ...input }) {
      const current = await runtime()
      if (!current) return notInstalled()
      const target = subject ?? (page === undefined ? undefined : { id: normalizeCommentPage(page), kind: "page" })
      if (!target) return [commentsErrors.COMMENTS_INVALID_INPUT({ issue: "subject: Give a subject, or a page." }), undefined]
      try {
        return [undefined, await createThread(current, { ...input, subject: target })]
      }
      catch (error) {
        const failure = resultError(error, target.id)
        return [failure.code === "COMMENTS_NOT_FOUND" ? commentsErrors.COMMENTS_INVALID_INPUT({ issue: failure.why }) : failure, undefined] as [ReturnType<typeof commentsErrors.COMMENTS_INVALID_INPUT>, undefined]
      }
    },
    async reply(threadId, input, replyOptions = {}) {
      const current = await runtime()
      if (!current) return notInstalled()
      const found = await current.store.getById(threadId)
      if (!found) return notFound(threadId)
      try {
        const { message } = await replyToThread(current, found, input, { allowResolved: replyOptions.allowResolved === true })
        return [undefined, message]
      }
      catch (error) {
        return [resultError(error, threadId), undefined]
      }
    },
    async resolve(threadId, { by }) {
      const current = await runtime()
      if (!current) return notInstalled()
      if (!await current.store.getById(threadId)) return notFound(threadId)
      const thread = await current.store.setStatus(threadId, "resolved", by, Date.now()).catch(gone)
      if (!thread) return notFound(threadId)
      current.forge?.changed(threadId)
      return [undefined, thread]
    },
    async reopen(threadId) {
      const current = await runtime()
      if (!current) return notInstalled()
      if (!await current.store.getById(threadId)) return notFound(threadId)
      const thread = await current.store.setStatus(threadId, "open", { id: "" }, Date.now()).catch(gone)
      if (!thread) return notFound(threadId)
      current.forge?.changed(threadId)
      return [undefined, thread]
    },
    async remove(threadId) {
      const current = await runtime()
      if (!current) return notInstalled()
      if (!await current.store.getById(threadId)) return notFound(threadId)
      await current.store.deleteThread(threadId)
      current.forge?.changed(threadId)
      return [undefined, undefined]
    },
    async removeMessage(messageId) {
      const current = await runtime()
      if (!current) return notInstalled()
      const thread = await current.store.getByMessage(messageId)
      if (!thread) return notFound(messageId)
      if (thread.messages[0]?.id === messageId) await current.store.deleteThread(thread.id)
      else await current.store.deleteMessage(thread.id, messageId, Date.now()).catch(gone)
      current.forge?.changed(thread.id)
      return [undefined, undefined]
    },
    async edit(messageId, input) {
      const current = await runtime()
      if (!current) return notInstalled()
      const thread = await current.store.getByMessage(messageId)
      if (!thread) return notFound(messageId)
      const author = thread.messages.find(message => message.id === messageId)!.author
      try {
        const next = await editMessage(current, thread, messageId, input, { user: author.guest ? null : { ...author } })
        return [undefined, next.messages.find(message => message.id === messageId)!]
      }
      catch (error) {
        const failure = resultError(error, messageId)
        return [failure.code === "COMMENTS_RESOLVED" ? commentsErrors.COMMENTS_INVALID_INPUT({ issue: failure.why }) : failure, undefined]
      }
    },
    async removeScope(scope) {
      const current = await runtime()
      if (!current) return notInstalled()
      if (!scope || scope.length > 256) return [undefined, { removed: 0 }]
      const removed = await current.store.deleteScope(scope)
      for (const threadId of removed) current.forge?.changed(threadId)
      return [undefined, { removed: removed.length }]
    },
    async can(context, gate) {
      const current = await runtime()
      return can(current ?? { definition: options }, context, gate)
    },
    async people({ query, user, thread, subject, limit = 20, gate }) {
      const current = await runtime()
      if (!current) return notInstalled()
      if (subject) scopeOf(current, subject)
      return [undefined, await suggest(current, { limit: Math.min(Math.max(limit, 1), 20), query, user, ...(gate ? { gate } : {}), ...(thread ? { thread } : {}), ...(subject ? { subject } : {}) })]
    },
    async sync(threadId) {
      await runtime()
      await runtimes.get(comments)?.sync?.(threadId)
    },
    async flush() {
      while (pending.size) await Promise.all(pending)
    },
  }
  Reflect.set(comments, pendingKey, pending)
  return Object.freeze(markCommentsDefinition(comments))
}
