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

export { createAnchor, resolveAnchor, selectorFor } from "./client-anchor.ts"
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
  create: (input: CommentCreateInput) => Promise<CommentThread>
  reply: (input: CommentReplyInput) => Promise<CommentThread>
  edit: (input: CommentEditInput) => Promise<CommentThread>
  delete: (input: CommentDeleteInput) => Promise<CommentThread | null>
  resolve: (input: CommentStatusInput) => Promise<CommentThread>
  reopen: (input: CommentStatusInput) => Promise<CommentThread>
  users: (input: CommentUsersInput) => Promise<CommentUser[]>
  /** Calls `listener` after every change of `threads`, `status`, or `error`. Returns a function that stops it. */
  onChange: (listener: () => void) => () => void
  /** Loads the threads, then keeps them fresh: pushed events when the transport has `subscribe`, else a refresh on window focus. Returns a function that stops it. */
  start: () => () => void
}

/** A cache and a change signal over a transport. It has no framework in it. */
export function createCommentsClient(options: CommentsClientOptions): CommentsClient {
  const { transport } = options
  const listeners = new Set<() => void>()
  const byId = new Map<string, CommentThread>()
  // Without a user identity, keep user-filter membership from the last successful transport list.
  let listed = new Set<string>()
  // What changed while a list was on its way. The list answers for the time it was asked, so it must not undo these.
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
  const matchesQuery = (thread: CommentThread): boolean => {
    const user = options.user
    if (query.subject && (thread.subject.kind !== query.subject.kind || thread.subject.id !== query.subject.id)) return false
    if (query.page !== undefined && (thread.subject.kind !== "page" || thread.subject.id !== query.page)) return false
    if (query.status && thread.status !== query.status) return false
    if (user && query.mine && thread.author.id !== user.id) return false
    if (user && query.mentions && !thread.messages.some(message => message.mentions.includes(user.id))) return false
    if (transportOwnsMembership() && !listed.has(thread.id)) return false
    return true
  }
  const publish = (): void => {
    // Keep versions for reconciliation even when an update moves a thread out of the visible query.
    threads = [...byId.values()].filter(matchesQuery).sort((a, b) => a.n - b.n)
    notify()
  }
  // A thread older than the one that the client holds is a late answer or a late event. It does not replace it.
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

  // Timestamps cannot order mutations within one millisecond. Send each thread's mutations in order.
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
      const list: CommentThread[] = []
      let before = requested.before
      while (true) {
        const page = await transport.list({ ...requested, limit: pageSize, ...(before ? { before } : {}) })
        if (current !== generation) return threads
        list.push(...page)
        if (requested.limit !== undefined || page.length < pageSize) break
        const last = page.at(-1)!
        before = { id: last.id, updatedAt: last.updatedAt }
      }
      // A newer refresh, or a query change, makes this answer stale.
      if (current !== generation) return threads
      const next = new Map<string, CommentThread>()
      for (const thread of list) {
        const local = byId.get(thread.id)
        if (removed.has(thread.id)) continue
        next.set(thread.id, local && (local.updatedAt > thread.updatedAt || (changed.has(thread.id) && local.updatedAt === thread.updatedAt)) ? local : thread)
      }
      // A thread that someone made or changed while the list was on its way is not in the list yet.
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

  const refreshQuietly = (): void => {
    refresh().catch(() => undefined)
  }
  const apply = (event: CommentEvent): void => {
    if (event.type === "thread") {
      // Only the transport can evaluate user filters when the client has no signed-in user.
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
    get: input => transport.get(input),
    create: async input => upsert(await transport.create(input)),
    reply: input => mutate(input.threadId, async () => upsert(await transport.reply(input))),
    edit: input => mutate(input.threadId, async () => upsert(await transport.edit(input))),
    delete: input => mutate(input.threadId, async () => {
      const next = await transport.delete(input)
      if (next) upsert(next)
      else drop(input.threadId)
      return next
    }),
    resolve: input => mutate(input.threadId, async () => upsert(await transport.resolve(input))),
    reopen: input => mutate(input.threadId, async () => upsert(await transport.reopen(input))),
    users: input => transport.users(input),
    onChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    start() {
      // Subscribe first, so an event that comes while the list is on its way is not lost.
      const stops: Array<() => void> = []
      if (transport.subscribe) stops.push(transport.subscribe(apply))
      else if (options.refreshOnFocus !== false && typeof window !== "undefined") {
        window.addEventListener("focus", refreshQuietly)
        stops.push(() => window.removeEventListener("focus", refreshQuietly))
      }
      refreshQuietly()
      return () => {
        for (const stop of stops.splice(0)) stop()
      }
    },
  }
}
