import { markCommentsDefinition } from "./operations-core/define.ts"
import { commentsRuntime, hasCommentsRuntime, installCommentsRuntime } from "./operations-core/server.ts"
import { can, createThread, editMessage, replyToThread, scopeOf, suggest } from "./operations-core/service.ts"
import { createCommentsStore } from "./operations-core/store.ts"
import { commentsSchemaGate } from "./migrate.ts"
import { commentsSchema } from "./operations-core/database.ts"
import { commentsErrors } from "./errors.ts"
import { createForgeSync } from "./forge/sync.ts"
import { normalizeCommentPage } from "./page.ts"

import type { Result } from "@vite-hub/runtime"
import type { CommentAction, CommentsPolicyGate, CommentsUser } from "./operations-core/define.ts"
import type { CommentsAttachmentStore, CommentsRuntime } from "./operations-core/service.ts"
import type { CommentsDatabase, CommentsStore, CommentsTables } from "./operations-core/store.ts"
import type { CommentsSchemaOwner } from "./migrate.ts"
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
import type { CommentsPeople } from "./operations-core/define.ts"

export { describeCommentContext } from "./context.ts"
export { commentRoom, commentsPageScope, commentsRealtimeDefinition, commentsRoute, normalizeCommentPage } from "./page.ts"
export { builtinCommentSubjects, defaultPolicy, defineCommentSubject } from "./operations-core/define.ts"
export type { CommentsPolicyGate } from "./operations-core/define.ts"
export { commentsErrorDiagnostics } from "./client-errors.ts"
export type * from "./types.ts"

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

interface Installed {
  runtime: CommentsRuntime
  sync?: (threadId: string) => Promise<void>
}

const runtimes = new WeakMap<Comments, Installed>()

/**
 * The runtime of a definition. The generated Nitro plugin of the comment operations builds it on first use, so a
 * server API call before any operation builds it too.
 */
async function runtimeOf(comments: Comments): Promise<CommentsRuntime | undefined> {
  const installed = runtimes.get(comments)?.runtime
  if (installed || !hasCommentsRuntime()) return installed
  const built = await commentsRuntime().catch(() => undefined)
  return built?.definition === comments.options ? built : undefined
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
  if (typeof code === "string" && ["COMMENTS_R0005", "COMMENTS_R0007", "COMMENTS_R0008", "COMMENTS_R0017", "COMMENTS_R0018"].includes(code)) {
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
      await runtimes.get(comments)?.sync?.(threadId)
    },
    async flush() {
      while (pending.size) await Promise.all(pending)
    },
  }
  Reflect.set(comments, pendingKey, pending)
  return Object.freeze(markCommentsDefinition(comments))
}

const pendingKey: unique symbol = Symbol.for("vitehub.comments.pending")

export interface InstallCommentsOptions {
  database: CommentsDatabase
  /** The tables of the Database schema, so a Postgres Database uses its own. Default: the SQLite tables. */
  tables?: CommentsTables & { commentForge?: typeof commentsSchema.vitehubCommentForge }
  /** The Auth adapter for `@` suggestions, when the app has Auth and no `people`. */
  users?: CommentsPeople
  /** The Blob store for attachments, when the app has one and no `storeAttachment`. */
  attachments?: CommentsAttachmentStore
  /** Only the Vite dev server enables it, for the default guest policy. Without it, the operation context decides, else `false`. */
  development?: boolean
  /**
   * Who keeps the tables up to date. `"comments"`: Comments opened the Database itself, so it migrates and creates
   * the tables before the first query. Default `"app"`: the app's migrations do, and Comments fails with
   * `COMMENTS_R0019` until the tables match this version. See `CommentsSchemaOwner`.
   */
  schema?: CommentsSchemaOwner
  /** The SQL dialect of `database`. Default `sqlite`: SQLite, libSQL, and D1. */
  dialect?: "sqlite" | "postgresql"
}

/** The store, after the tables are ready: each method waits for `ready` first. */
function gated(store: CommentsStore, ready: () => Promise<void>): CommentsStore {
  const wrapped: Partial<Record<keyof CommentsStore, unknown>> = {}
  for (const key of Object.keys(store) as Array<keyof CommentsStore>) {
    const method = store[key] as (...args: unknown[]) => Promise<unknown>
    wrapped[key] = async (...args: unknown[]) => {
      await ready()
      return method(...args)
    }
  }
  // SAFETY: every key of the store maps to a wrapper with the same parameters and result.
  return wrapped as CommentsStore
}

/**
 * Connects a Comments definition to its Database, for the server API, the overlay API, and the comment operations.
 * The generated Nitro plugin calls it when the server starts; call it yourself only in tests or outside ViteHub.
 */
export function installComments(comments: Comments, install: InstallCommentsOptions): CommentsRuntime {
  const tables = install.tables ?? { commentCounters: commentsSchema.vitehubCommentCounters, commentMessages: commentsSchema.vitehubCommentMessages, commentThreads: commentsSchema.vitehubCommentThreads }
  const store = gated(createCommentsStore(install.database, tables), commentsSchemaGate(install.database, install.schema ?? "app", { dialect: install.dialect ?? "sqlite" }))
  // SAFETY: defineComments() sets this slot to the set of pending tasks before it freezes the object.
  const pending = Reflect.get(comments, pendingKey) as Set<Promise<unknown>> | undefined
  const track = (task: Promise<unknown>) => {
    if (!pending) return
    const tracked = task.catch(() => undefined).finally(() => pending.delete(tracked))
    pending.add(tracked)
  }
  const runtime: CommentsRuntime = {
    background: track,
    definition: comments.options,
    ...(install.development === undefined ? {} : { development: install.development }),
    store,
    ...(install.users ? { users: install.users } : {}),
    ...(install.attachments ? { attachments: install.attachments } : {}),
  }
  let sync: Installed["sync"]
  if (comments.options.forge) {
    const forge = createForgeSync(comments.options.forge, { database: install.database, store, ...(install.tables?.commentForge ? { table: install.tables.commentForge } : {}) })
    sync = forge.sync
    runtime.forge = {
      attach: forge.attach,
      changed(threadId) {
        track(forge.sync(threadId).catch(error => console.error(`[vitehub] Comments could not sync thread ${threadId} to its pull request:`, error)))
      },
    }
  }
  runtimes.set(comments, { runtime, ...(sync ? { sync } : {}) })
  // The comment operations of the Console, the CLI, and MCP share the runtime.
  installCommentsRuntime(runtime)
  return runtime
}

/** The runtime that `installComments()` connected, for the overlay API and the MCP tools. */
export function commentsRuntimeOf(comments: Comments): CommentsRuntime | undefined {
  return runtimes.get(comments)?.runtime
}
