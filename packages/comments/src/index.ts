import * as v from "valibot"

import { commentsErrors } from "./errors.ts"
import { normalizeCommentPage } from "./page.ts"
import { createThreadSchema, describeIssue, replySchema } from "./schema.ts"
import { createCommentsStore } from "./store.ts"

import type { Result } from "@vite-hub/runtime"
import type { CommentsDatabase, CommentsStore } from "./store.ts"
import type {
  Comment,
  CommentAuthor,
  CommentMention,
  CommentsAuthorizeContext,
  CommentsErrorCode,
  CommentThread,
  CreateCommentThreadInput,
  DefineCommentsOptions,
  ListCommentThreadsOptions,
  ReplyInput,
} from "./types.ts"

export { describeCommentContext } from "./context.ts"
export { commentRoom, commentsHintCookie, commentsHintQuery, commentsRealtimeDefinition, commentsRoute, normalizeCommentPage } from "./page.ts"
export type * from "./types.ts"

type Codes<T extends CommentsErrorCode> = T

/** The Comments runtime of an app: the `comments` export of `server/comments.ts`. */
export interface Comments {
  readonly options: DefineCommentsOptions
  /** Threads with their comments, newest activity first. */
  list(options?: ListCommentThreadsOptions): Promise<Result<CommentThread[], Codes<"COMMENTS_NOT_INSTALLED">>>
  get(id: string): Promise<Result<CommentThread, Codes<"COMMENTS_NOT_INSTALLED" | "COMMENTS_NOT_FOUND">>>
  /** Starts a thread with its first comment. Runs `onComment`. */
  create(input: CreateCommentThreadInput): Promise<Result<CommentThread, Codes<"COMMENTS_NOT_INSTALLED" | "COMMENTS_INVALID_INPUT">>>
  /** Adds a comment to an open thread. Runs `onComment`. */
  reply(threadId: string, input: ReplyInput): Promise<Result<Comment, Codes<"COMMENTS_NOT_INSTALLED" | "COMMENTS_NOT_FOUND" | "COMMENTS_INVALID_INPUT" | "COMMENTS_RESOLVED">>>
  resolve(threadId: string, options: { by: CommentAuthor }): Promise<Result<CommentThread, Codes<"COMMENTS_NOT_INSTALLED" | "COMMENTS_NOT_FOUND">>>
  reopen(threadId: string): Promise<Result<CommentThread, Codes<"COMMENTS_NOT_INSTALLED" | "COMMENTS_NOT_FOUND">>>
  /** Deletes a thread and all its comments. */
  remove(threadId: string): Promise<Result<void, Codes<"COMMENTS_NOT_INSTALLED" | "COMMENTS_NOT_FOUND">>>
  /** Deletes one comment. Deleting the first comment deletes the thread. */
  removeComment(commentId: string): Promise<Result<void, Codes<"COMMENTS_NOT_INSTALLED" | "COMMENTS_NOT_FOUND">>>
  /** Whether the `authorize` policy allows an action. Without a policy, signed-in users may do everything. */
  can(context: CommentsAuthorizeContext): Promise<boolean>
  /** People that `@` suggests: the `people` option, or the authors of earlier comments. */
  people(context: { query: string, user: CommentsAuthorizeContext["user"] }): Promise<Result<CommentMention[], Codes<"COMMENTS_NOT_INSTALLED">>>
}

const runtimes = new WeakMap<Comments, CommentsStore>()

/**
 * Defines Comments for the app. Export it as `comments` from `server/comments.ts`; ViteHub then stores threads in the
 * Database, serves the Comments API, and adds the overlay to pages for the people that `authorize` allows.
 */
export function defineComments(options: DefineCommentsOptions = {}): Comments {
  const store = () => runtimes.get(comments)
  const notInstalled = (): [ReturnType<typeof commentsErrors.COMMENTS_NOT_INSTALLED>, undefined] => [commentsErrors.COMMENTS_NOT_INSTALLED(), undefined]
  const notFound = (id: string): [ReturnType<typeof commentsErrors.COMMENTS_NOT_FOUND>, undefined] => [commentsErrors.COMMENTS_NOT_FOUND({ id }), undefined]

  async function notify(thread: CommentThread, comment: Comment): Promise<void> {
    if (!options.onComment) return
    try {
      await options.onComment({ thread, comment, mentions: comment.mentions })
    }
    catch (error) {
      console.error("[vitehub] Comments onComment failed:", error)
    }
  }

  const comments: Comments = {
    options,
    async list(query = {}) {
      const current = store()
      if (!current) return notInstalled()
      const limit = Math.min(Math.max(query.limit ?? 200, 1), 500)
      return [undefined, await current.list({ page: query.page === undefined ? undefined : normalizeCommentPage(query.page), status: query.status, limit })]
    },
    async get(id) {
      const current = store()
      if (!current) return notInstalled()
      const thread = await current.get(id)
      return thread ? [undefined, thread] : notFound(id)
    },
    async create(input) {
      const current = store()
      if (!current) return notInstalled()
      const parsed = v.safeParse(createThreadSchema, input)
      if (!parsed.success) return [commentsErrors.COMMENTS_INVALID_INPUT({ issue: describeIssue(parsed.issues) }), undefined]
      const thread = await current.create({ ...parsed.output, page: normalizeCommentPage(parsed.output.page) })
      await notify(thread, thread.comments[0]!)
      return [undefined, thread]
    },
    async reply(threadId, input) {
      const current = store()
      if (!current) return notInstalled()
      const parsed = v.safeParse(replySchema, input)
      if (!parsed.success) return [commentsErrors.COMMENTS_INVALID_INPUT({ issue: describeIssue(parsed.issues) }), undefined]
      const thread = await current.get(threadId)
      if (!thread) return notFound(threadId)
      if (thread.status === "resolved") return [commentsErrors.COMMENTS_RESOLVED(), undefined]
      const comment = await current.reply(threadId, parsed.output)
      await notify({ ...thread, comments: [...thread.comments, comment] }, comment)
      return [undefined, comment]
    },
    async resolve(threadId, { by }) {
      const current = store()
      if (!current) return notInstalled()
      if (!await current.get(threadId)) return notFound(threadId)
      await current.setStatus(threadId, "resolved", by)
      return [undefined, (await current.get(threadId))!]
    },
    async reopen(threadId) {
      const current = store()
      if (!current) return notInstalled()
      if (!await current.get(threadId)) return notFound(threadId)
      await current.setStatus(threadId, "open", null)
      return [undefined, (await current.get(threadId))!]
    },
    async remove(threadId) {
      const current = store()
      if (!current) return notInstalled()
      if (!await current.get(threadId)) return notFound(threadId)
      await current.removeThread(threadId)
      return [undefined, undefined]
    },
    async removeComment(commentId) {
      const current = store()
      if (!current) return notInstalled()
      const threadId = await current.threadOf(commentId)
      if (!threadId) return notFound(commentId)
      const thread = await current.get(threadId)
      if (thread?.comments[0]?.id === commentId) await current.removeThread(threadId)
      else await current.removeComment(commentId)
      return [undefined, undefined]
    },
    async can(context) {
      if (!options.authorize) return context.user !== null
      return await options.authorize(context) !== false
    },
    async people({ query, user }) {
      const current = store()
      if (!current) return notInstalled()
      const all = options.people ? await options.people({ query, user }) : await current.authors(50)
      const needle = query.trim().toLowerCase()
      return [undefined, all.filter(person => !needle || person.name.toLowerCase().includes(needle)).slice(0, 20).map(({ id, name }) => ({ id, name }))]
    },
  }
  return comments
}

/**
 * Connects a Comments definition to its Database. The generated Nitro plugin calls it when the server starts; call it
 * yourself only in tests or outside ViteHub.
 */
export function installComments(comments: Comments, runtime: { database: CommentsDatabase }): void {
  runtimes.set(comments, createCommentsStore(runtime.database))
}
