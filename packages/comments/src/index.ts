import * as v from "valibot"

import { commentsErrors } from "./errors.ts"
import { commentsPageScope, normalizeCommentPage } from "./page.ts"
import { createThreadSchema, describeIssue, editSchema, replySchema, scopeSchema } from "./schema.ts"
import { createCommentsStore } from "./store.ts"
import { createForgeSync } from "./forge/sync.ts"

import type { Result } from "@vite-hub/runtime"
import type { ForgeSync } from "./forge/sync.ts"
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
  EditCommentInput,
  ListCommentThreadsOptions,
  ReplyInput,
  ReplyOptions,
} from "./types.ts"

export { describeCommentContext } from "./context.ts"
export { commentRoom, commentsHintCookie, commentsPageScope, commentsHintQuery, commentsRealtimeDefinition, commentsRoute, normalizeCommentPage } from "./page.ts"
export type * from "./types.ts"

type Codes<T extends CommentsErrorCode> = T

/** The Comments runtime of an app: the `comments` export of `server/comments.ts`. */
export interface Comments {
  readonly options: DefineCommentsOptions
  /** Threads with their comments, newest activity first. */
  list(options?: ListCommentThreadsOptions): Promise<Result<CommentThread[], Codes<"COMMENTS_NOT_INSTALLED">>>
  get(id: string): Promise<Result<CommentThread, Codes<"COMMENTS_NOT_INSTALLED" | "COMMENTS_NOT_FOUND">>>
  /** The thread that holds a comment, for a route that has only the comment id. */
  getByComment(commentId: string): Promise<Result<CommentThread, Codes<"COMMENTS_NOT_INSTALLED" | "COMMENTS_NOT_FOUND">>>
  /** Thread `#number` of a scope. */
  getByNumber(scope: string, number: number): Promise<Result<CommentThread, Codes<"COMMENTS_NOT_INSTALLED" | "COMMENTS_NOT_FOUND">>>
  /**
   * Starts a thread with its first comment, numbered next in its scope. Runs `onComment`. A thread of the `"pages"`
   * scope needs an `anchor`; other scopes keep their own anchor in `metadata`.
   */
  create(input: CreateCommentThreadInput): Promise<Result<CommentThread, Codes<"COMMENTS_NOT_INSTALLED" | "COMMENTS_INVALID_INPUT">>>
  /** Adds a comment to an open thread. Runs `onComment`. */
  reply(threadId: string, input: ReplyInput, options?: ReplyOptions): Promise<Result<Comment, Codes<"COMMENTS_NOT_INSTALLED" | "COMMENTS_NOT_FOUND" | "COMMENTS_INVALID_INPUT" | "COMMENTS_RESOLVED">>>
  resolve(threadId: string, options: { by: CommentAuthor }): Promise<Result<CommentThread, Codes<"COMMENTS_NOT_INSTALLED" | "COMMENTS_NOT_FOUND">>>
  reopen(threadId: string): Promise<Result<CommentThread, Codes<"COMMENTS_NOT_INSTALLED" | "COMMENTS_NOT_FOUND">>>
  /** Deletes a thread and all its comments. */
  remove(threadId: string): Promise<Result<void, Codes<"COMMENTS_NOT_INSTALLED" | "COMMENTS_NOT_FOUND">>>
  /** Deletes one comment. Deleting the first comment deletes the thread. */
  removeComment(commentId: string): Promise<Result<void, Codes<"COMMENTS_NOT_INSTALLED" | "COMMENTS_NOT_FOUND">>>
  /** Changes the text of a comment and sets `editedAt`. */
  edit(commentId: string, input: EditCommentInput): Promise<Result<Comment, Codes<"COMMENTS_NOT_INSTALLED" | "COMMENTS_NOT_FOUND" | "COMMENTS_INVALID_INPUT">>>
  /** Deletes every thread of a scope, such as when app code deletes the document that the scope names. */
  removeScope(scope: string): Promise<Result<{ removed: number }, Codes<"COMMENTS_NOT_INSTALLED">>>
  /**
   * Whether the `authorize` policy allows an action. Without a policy, signed-in users may do everything. `scope`
   * defaults to the thread's, else `"pages"`.
   */
  can(context: Omit<CommentsAuthorizeContext, "scope"> & { scope?: string }): Promise<boolean>
  /**
   * People that `@` suggests: the `people` option, or the authors of earlier comments in the scope, `"pages"` by
   * default, so names from an app's own scopes never reach the overlay.
   */
  people(context: { query: string, user: CommentsAuthorizeContext["user"], scope?: string }): Promise<Result<CommentMention[], Codes<"COMMENTS_NOT_INSTALLED">>>
  /**
   * With `forge`: brings the thread's pull request comments in line with the thread now, and posts what failed
   * before. Every change starts this on its own; `flush()` waits for it.
   */
  sync(threadId: string): Promise<void>
  /** Waits for the pull request syncs that earlier changes started. On Cloudflare, pass it to `waitUntil`. */
  flush(): Promise<void>
}

const runtimes = new WeakMap<Comments, { store: CommentsStore, forge?: ForgeSync }>()

/**
 * Defines Comments for the app. Export it as `comments` from `server/comments.ts`; ViteHub then stores threads in the
 * Database, serves the Comments API, and adds the overlay to pages for the people that `authorize` allows.
 */
export function defineComments(options: DefineCommentsOptions = {}): Comments {
  const store = () => runtimes.get(comments)?.store
  const pending = new Set<Promise<void>>()

  /** Starts the pull request sync of a thread after a change. Errors are logged; the next change tries again. */
  function changed(threadId: string): void {
    const forge = runtimes.get(comments)?.forge
    if (!forge) return
    const task: Promise<void> = forge.sync(threadId)
      .catch(error => console.error(`[vitehub] Comments could not sync thread ${threadId} to its pull request:`, error))
      .finally(() => pending.delete(task))
    pending.add(task)
  }

  async function withForge(threads: CommentThread[]): Promise<CommentThread[]> {
    const forge = runtimes.get(comments)?.forge
    return forge ? await forge.attach(threads) : threads
  }
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
      return [undefined, await withForge(await current.list({ scope: query.scope, page: query.page === undefined ? undefined : normalizeCommentPage(query.page), status: query.status, limit }))]
    },
    async get(id) {
      const current = store()
      if (!current) return notInstalled()
      const [thread] = await withForge([await current.get(id)].filter(found => found !== undefined))
      return thread ? [undefined, thread] : notFound(id)
    },
    async getByComment(commentId) {
      const current = store()
      if (!current) return notInstalled()
      const threadId = await current.threadOf(commentId)
      const [thread] = await withForge([threadId ? await current.get(threadId) : undefined].filter(found => found !== undefined))
      return thread ? [undefined, thread] : notFound(commentId)
    },
    async getByNumber(scope, number) {
      const current = store()
      if (!current) return notInstalled()
      const [thread] = await withForge([await current.getByNumber(scope, number)].filter(found => found !== undefined))
      return thread ? [undefined, thread] : notFound(`${scope}#${number}`)
    },
    async create(input) {
      const current = store()
      if (!current) return notInstalled()
      const parsed = v.safeParse(createThreadSchema, input)
      if (!parsed.success) return [commentsErrors.COMMENTS_INVALID_INPUT({ issue: describeIssue(parsed.issues) }), undefined]
      if (parsed.output.scope === commentsPageScope && !parsed.output.anchor) {
        return [commentsErrors.COMMENTS_INVALID_INPUT({ issue: "anchor: A thread on a page needs an anchor." }), undefined]
      }
      const thread = await current.create({ ...parsed.output, page: normalizeCommentPage(parsed.output.page) })
      await notify(thread, thread.comments[0]!)
      changed(thread.id)
      return [undefined, thread]
    },
    async reply(threadId, input, replyOptions = {}) {
      const current = store()
      if (!current) return notInstalled()
      const parsed = v.safeParse(replySchema, input)
      if (!parsed.success) return [commentsErrors.COMMENTS_INVALID_INPUT({ issue: describeIssue(parsed.issues) }), undefined]
      const result = await current.reply(threadId, parsed.output, replyOptions)
      if ("error" in result) return result.error === "resolved" ? [commentsErrors.COMMENTS_RESOLVED(), undefined] : notFound(threadId)
      const { comment, thread } = result
      await notify(thread, comment)
      changed(threadId)
      return [undefined, comment]
    },
    async resolve(threadId, { by }) {
      const current = store()
      if (!current) return notInstalled()
      const thread = await current.setStatus(threadId, "resolved", by)
      if (thread) changed(threadId)
      return thread ? [undefined, thread] : notFound(threadId)
    },
    async reopen(threadId) {
      const current = store()
      if (!current) return notInstalled()
      const thread = await current.setStatus(threadId, "open", null)
      if (thread) changed(threadId)
      return thread ? [undefined, thread] : notFound(threadId)
    },
    async remove(threadId) {
      const current = store()
      if (!current) return notInstalled()
      if (!await current.get(threadId)) return notFound(threadId)
      await current.removeThread(threadId)
      changed(threadId)
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
      changed(threadId)
      return [undefined, undefined]
    },
    async edit(commentId, input) {
      const current = store()
      if (!current) return notInstalled()
      const parsed = v.safeParse(editSchema, input)
      if (!parsed.success) return [commentsErrors.COMMENTS_INVALID_INPUT({ issue: describeIssue(parsed.issues) }), undefined]
      const comment = await current.edit(commentId, parsed.output)
      if (comment) changed(comment.threadId)
      return comment ? [undefined, comment] : notFound(commentId)
    },
    async removeScope(scope) {
      const current = store()
      if (!current) return notInstalled()
      if (!v.is(scopeSchema, scope)) return [undefined, { removed: 0 }]
      const removed = await current.removeScope(scope)
      for (const threadId of removed) changed(threadId)
      return [undefined, { removed: removed.length }]
    },
    async can(context) {
      if (!options.authorize) return context.user !== null
      const scope = context.scope ?? context.thread?.scope ?? commentsPageScope
      return await options.authorize({ ...context, scope }) !== false
    },
    async people({ query, user, scope = commentsPageScope }) {
      const current = store()
      if (!current) return notInstalled()
      const all = options.people ? await options.people({ query, user }) : await current.authors(scope, 50)
      const needle = query.trim().toLowerCase()
      return [undefined, all.filter(person => !needle || person.name.toLowerCase().includes(needle)).slice(0, 20).map(({ id, name }) => ({ id, name }))]
    },
    async sync(threadId) {
      await runtimes.get(comments)?.forge?.sync(threadId)
    },
    async flush() {
      while (pending.size) await Promise.all(pending)
    },
  }
  return comments
}

/**
 * Connects a Comments definition to its Database. The generated Nitro plugin calls it when the server starts; call it
 * yourself only in tests or outside ViteHub.
 */
export function installComments(comments: Comments, runtime: { database: CommentsDatabase }): void {
  const store = createCommentsStore(runtime.database)
  const forge = comments.options.forge ? createForgeSync(comments.options.forge, { database: runtime.database, store }) : undefined
  runtimes.set(comments, forge ? { store, forge } : { store })
}
