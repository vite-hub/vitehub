import { commentsClientDiagnostics } from "./client-diagnostics.ts"
import { createOutbox } from "./client-outbox.ts"

import type {
  CommentCreateInput,
  CommentDeleteInput,
  CommentEditInput,
  CommentEvent,
  CommentGetInput,
  CommentListQuery,
  CommentReplyInput,
  CommentsTransport,
  CommentStatusInput,
  CommentThread,
  CommentUser,
  CommentUsersInput,
} from "./client-types.ts"
import type { CommentsClientFiles, CommentsOutbox, CommentsOutboxOptions } from "./client-outbox.ts"

export { commentsAgentPrompt } from "./agent-prompt.ts"
export type { CommentsAgentPromptInput } from "./agent-prompt.ts"
export { anchorRange, createAnchor, resolveAnchor, selectorFor } from "./client-anchor.ts"
export type {
  AnchorPoint,
  AnchorPosition,
  AnchorRect,
  AnchorTarget,
  CreateAnchorOptions,
  DetachedAnchor,
  ResolvedAnchor,
} from "./client-anchor.ts"
export { commentsErrorDiagnostics } from "./client-errors.ts"
export { createIndexedDBOutboxStore, createMemoryOutboxStore } from "./client-outbox.ts"
export type { CommentsClientFiles, CommentsOutbox, CommentsOutboxEntry, CommentsOutboxEnvironment, CommentsOutboxMessage, CommentsOutboxOptions, CommentsOutboxStore } from "./client-outbox.ts"
export { createCommentSend } from "./client-send.ts"
export type {
  CommentSendAgent,
  CommentSendClient,
  CommentSendCopy,
  CommentSendEvent,
  CommentSendLogo,
  CommentSendOptions,
  CommentSendPairing,
  CommentSendPairingCheck,
  CommentSendResult,
  CommentSendState,
  CommentSendStatus,
  CommentSendTransport,
} from "./client-send.ts"
export { createCommentSendTransport } from "./send-transport.ts"
export type { CommentSendTransportOptions } from "./send-transport.ts"
export { foldName } from "./fold-name.ts"
export { replyMessageId } from "./reply-id.ts"
export { commentAttachmentUrl, createCommentsRestRequest, createRestTransport } from "./rest-transport.ts"
export type { CommentsGuest, CommentsRestAnswer, CommentsRestRequest, RestCommentThread, RestTransport, RestTransportOptions } from "./rest-transport.ts"
export type * from "./client-types.ts"

export type CommentsClientStatus = "idle" | "loading" | "ready" | "error"

export interface CommentsClientOptions {
  transport: CommentsTransport
  /** The signed-in user. The UI uses it for the "mine" filter and to know which messages the user may edit. */
  user?: CommentUser
  /** What `refresh()` lists. For example `{ page: "/pricing" }`. Without an explicit limit, loads all pages. */
  query?: CommentListQuery
  /** Refresh when the window gets focus and the transport cannot push updates. Default `true`. */
  refreshOnFocus?: boolean
  /**
   * Shows each new comment and reply at once and saves it before it sends, so it survives a reload and goes out once
   * when the network is back. Off by default: `create` and `reply` wait for the server.
   */
  outbox?: CommentsOutboxOptions
}

export interface CommentsClient {
  readonly transport: CommentsTransport
  readonly user: CommentUser | undefined
  /** The threads that the last `refresh()` and every change since then produced, ordered by `n`. A new array after each change. */
  readonly threads: readonly CommentThread[]
  readonly status: CommentsClientStatus
  readonly error: unknown
  query: CommentListQuery
  refresh: () => Promise<readonly CommentThread[]>
  get: (input: CommentGetInput) => Promise<CommentThread | null>
  /**
   * With an outbox, shows the comment at once. With no supplied `requestId`, returns the waiting thread before the save.
   * With a supplied `requestId`, waits for the save to check for a replay. `files` may be a promise.
   */
  create: (input: CommentCreateInput & CommentsClientFiles) => Promise<CommentThread>
  /** With an outbox, shows the reply at once. `requestId` and `files` work as they do for `create`. */
  reply: (input: CommentReplyInput & CommentsClientFiles) => Promise<CommentThread>
  edit: (input: CommentEditInput) => Promise<CommentThread>
  delete: (input: CommentDeleteInput) => Promise<CommentThread | null>
  resolve: (input: CommentStatusInput) => Promise<CommentThread>
  reopen: (input: CommentStatusInput) => Promise<CommentThread>
  users: (input: CommentUsersInput) => Promise<CommentUser[]>
  /** Calls `listener` after every change of `threads`, `status`, or `error`. Returns a function that stops it. */
  onChange: (listener: () => void) => () => void
  /**
   * Loads the threads, then keeps them fresh: pushed events when the transport has `subscribe`, else a refresh on window
   * focus. With an outbox, it also sends what an earlier page saved, and tries again when the page is back online.
   * Returns a function that stops it.
   */
  start: () => () => void
  /** The saved comments and replies that have not gone out. Only with the `outbox` option. */
  readonly outbox: CommentsOutbox | undefined
}

async function filesArrived<T extends CommentsClientFiles>({ files, ...input }: T) {
  return { ...input, ...(files ? { files: await files } : {}) }
}

/** A cache and a change signal over a transport. It has no framework in it. */
export function createCommentsClient(options: CommentsClientOptions & { outbox: CommentsOutboxOptions }): CommentsClient & { readonly outbox: CommentsOutbox }
export function createCommentsClient(options: CommentsClientOptions): CommentsClient
export function createCommentsClient(options: CommentsClientOptions): CommentsClient {
  const { transport } = options
  const listeners = new Set<() => void>()
  const byId = new Map<string, CommentThread>()
  let listed = new Set<string>()
  let changed = new Set<string>()
  let removed = new Set<string>()
  let threads: readonly CommentThread[] = []
  let status: CommentsClientStatus = "idle"
  let error: unknown
  let query = options.query ?? {}
  let generation = 0

  const transportOwnsMembership = (): boolean => !options.user && Boolean(query.mine || query.mentions)

  const notify = (): void => {
    for (const listener of listeners) listener()
  }
  const matchesQuery = (thread: CommentThread, waiting = false): boolean => {
    const user = options.user
    if (query.subject && (thread.subject.kind !== query.subject.kind || thread.subject.id !== query.subject.id)) return false
    if (query.subjectKind !== undefined && thread.subject.kind !== query.subjectKind) return false
    if (query.page !== undefined && (thread.subject.kind !== "page" || thread.subject.id !== query.page)) return false
    if (query.revision && (thread.revision === undefined || thread.revision > query.revision.lte)) return false
    if (query.status && thread.status !== query.status) return false
    if (user && query.mine && thread.author.id !== user.id) return false
    if (user && query.mentions && !thread.messages.some(message => message.mentions.includes(user.id))) return false
    if (waiting) return !(query.mentions && !user)
    if (transportOwnsMembership() && !listed.has(thread.id)) return false
    return true
  }
  const publish = (): void => {
    const stored = [...byId.values()]
    const { server, local } = outbox ? outbox.overlay(stored) : { server: stored, local: [] }
    threads = [...server.filter(thread => matchesQuery(thread)).sort((a, b) => a.n - b.n), ...local.filter(thread => matchesQuery(thread, true))]
    notify()
  }
  const upsert = (thread: CommentThread): CommentThread => {
    const stored = byId.get(thread.id)
    if (removed.has(thread.id) || (stored && stored.updatedAt > thread.updatedAt)) return stored ?? thread
    byId.set(thread.id, thread)
    changed.add(thread.id)
    publish()
    if (transportOwnsMembership()) refreshQuietly()
    return thread
  }
  const drop = (threadId: string): void => {
    removed.add(threadId)
    changed.delete(threadId)
    if (byId.delete(threadId)) publish()
  }

  const mutations = new Map<string, Promise<unknown>>()
  const mutate = async <T>(threadId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = mutations.get(threadId)
    const request = (async () => {
      await previous?.catch(() => undefined)
      return operation()
    })()
    mutations.set(threadId, request)
    try {
      return await request
    } finally {
      if (mutations.get(threadId) === request) mutations.delete(threadId)
    }
  }

  const refresh = async (): Promise<readonly CommentThread[]> => {
    const current = ++generation
    changed = new Set()
    removed = new Set()
    status = "loading"
    notify()
    try {
      const requested = { ...query }
      const pageSize = requested.limit ?? 200
      let list: CommentThread[] = []
      let previousSnapshot: string | undefined
      for (let scan = 0; ; scan++) {
        list = []
        let before = requested.before
        let pages = 0
        while (true) {
          const page = await transport.list({ ...requested, limit: pageSize, ...(before ? { before } : {}) })
          if (current !== generation) return threads
          pages++
          list.push(...page)
          if (requested.limit !== undefined || page.length < pageSize) break
          const last = page.at(-1)!
          before = { id: last.id, updatedAt: last.updatedAt }
        }
        if (requested.limit !== undefined || (pages === 1 && previousSnapshot === undefined)) break
        const snapshot = JSON.stringify(list)
        if (snapshot === previousSnapshot) break
        if (scan === 2) throw commentsClientDiagnostics.COMMENTS_R0015()
        previousSnapshot = snapshot
      }
      if (current !== generation) return threads
      const next = new Map<string, CommentThread>()
      for (const thread of list) {
        const local = byId.get(thread.id)
        if (removed.has(thread.id)) continue
        next.set(thread.id, local && (local.updatedAt > thread.updatedAt || (changed.has(thread.id) && local.updatedAt === thread.updatedAt)) ? local : thread)
      }
      for (const id of changed) {
        const local = byId.get(id)
        if (local && !next.has(id)) next.set(id, local)
      }
      byId.clear()
      for (const [id, thread] of next) byId.set(id, thread)
      listed = new Set(list.map(thread => thread.id))
      status = "ready"
      error = undefined
      publish()
    } catch (cause) {
      if (current === generation) {
        status = "error"
        error = cause
        notify()
      }
      throw cause
    }
    return threads
  }

  const shown = (threadId: string): CommentThread | null => {
    const stored = byId.get(threadId)
    const { server, local } = outbox ? outbox.overlay(stored ? [stored] : []) : { server: stored ? [stored] : [], local: [] }
    return server[0] ?? local.find(thread => thread.id === threadId) ?? null
  }
  const outbox = options.outbox && createOutbox(options.outbox, {
    transport,
    user: options.user,
    threads: () => byId.values(),
    upsert: thread => void upsert(thread),
    changed: publish,
  })

  const refreshQuietly = (): void => {
    refresh().catch(() => undefined)
  }
  const apply = (event: CommentEvent): void => {
    if (event.type === "thread") {
      if (!options.user && (query.mine || query.mentions)) return refreshQuietly()
      const local = byId.get(event.thread.id)
      if (local?.updatedAt === event.thread.updatedAt) refreshQuietly()
      else upsert(event.thread)
    }
    else if (event.type === "deleted") drop(event.threadId)
    else refreshQuietly()
  }

  return {
    transport,
    user: options.user,
    get threads() {
      return threads
    },
    get status() {
      return status
    },
    get error() {
      return error
    },
    get query() {
      return query
    },
    set query(next) {
      query = next
      generation++
      listed.clear()
      publish()
    },
    refresh,
    get: async (input) => {
      const thread = await transport.get(input)
      if (!thread || !outbox) return thread
      upsert(thread)
      return shown(thread.id) ?? thread
    },
    create: async input => outbox ? outbox.create(input) : upsert(await transport.create(await filesArrived(input))),
    reply: input => outbox ? outbox.reply(input) : mutate(input.threadId, async () => upsert(await transport.reply(await filesArrived(input)))),
    edit: async (input) => {
      if (outbox?.owns(input.threadId, input.messageId)) {
        if (!await outbox.edit(input.messageId, input.body, input.mentions)) throw commentsClientDiagnostics.COMMENTS_OUTBOX_SENDING()
        // SAFETY: the outbox keeps a reply only for a thread that the client shows, and `owns` found the entry.
        return shown(input.threadId)!
      }
      return mutate(input.threadId, async () => upsert(await transport.edit(input)))
    },
    delete: async (input) => {
      if (outbox?.owns(input.threadId, input.messageId)) {
        if (!await outbox.dismiss(input.messageId ?? input.threadId)) throw commentsClientDiagnostics.COMMENTS_OUTBOX_SENDING()
        return shown(input.threadId)
      }
      return mutate(input.threadId, async () => {
        const next = await transport.delete(input)
        if (next) upsert(next)
        else drop(input.threadId)
        return next
      })
    },
    resolve: input => mutate(input.threadId, async () => {
      const threadId = outbox ? await outbox.beforeResolve(input.threadId) : input.threadId
      if (threadId === undefined) throw commentsClientDiagnostics.COMMENTS_OUTBOX_RESOLVE_BLOCKED()
      return upsert(await transport.resolve({ ...input, threadId }))
    }),
    reopen: input => mutate(input.threadId, async () => upsert(await transport.reopen(input))),
    users: input => transport.users(input),
    outbox,
    onChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    start() {
      const stops: Array<() => void> = []
      if (transport.subscribe) stops.push(transport.subscribe(apply))
      else if (options.refreshOnFocus !== false && typeof window !== "undefined") {
        window.addEventListener("focus", refreshQuietly)
        stops.push(() => window.removeEventListener("focus", refreshQuietly))
      }
      if (outbox) stops.push(outbox.start())
      refreshQuietly()
      return () => {
        for (const stop of stops.splice(0)) stop()
      }
    },
  }
}
