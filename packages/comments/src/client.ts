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
} from "./types.ts"

export { createAnchor, resolveAnchor, selectorFor } from "./anchor.ts"
export type {
  AnchorPoint,
  AnchorPosition,
  AnchorRect,
  AnchorTarget,
  CreateAnchorOptions,
  DetachedAnchor,
  ResolvedAnchor,
} from "./anchor.ts"
export { commentsErrorDiagnostics } from "./errors.ts"
export type * from "./types.ts"

export type CommentsClientStatus = "idle" | "loading" | "ready" | "error"

export interface CommentsClientOptions {
  transport: CommentsTransport
  /** The signed-in user. The UI uses it for the "mine" filter and to know which messages the user may edit. */
  user?: CommentUser
  /** What `refresh()` lists. For example `{ page: "/pricing" }`. */
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
  // What changed while a list was on its way. The list answers for the time it was asked, so it must not undo these.
  let changed = new Set<string>()
  let removed = new Set<string>()
  let threads: readonly CommentThread[] = []
  let status: CommentsClientStatus = "idle"
  let error: unknown
  let query = options.query ?? {}
  let generation = 0

  const notify = (): void => {
    for (const listener of [...listeners]) listener()
  }
  const publish = (): void => {
    threads = [...byId.values()].sort((a, b) => a.n - b.n)
    notify()
  }
  // A thread older than the one that the client holds is a late answer or a late event. It does not replace it.
  const upsert = (thread: CommentThread): CommentThread => {
    const stored = byId.get(thread.id)
    if (removed.has(thread.id) || (stored && stored.updatedAt > thread.updatedAt)) return stored ?? thread
    byId.set(thread.id, thread)
    changed.add(thread.id)
    publish()
    return thread
  }
  const drop = (threadId: string): void => {
    removed.add(threadId)
    changed.delete(threadId)
    if (byId.delete(threadId)) publish()
  }

  const refresh = async (): Promise<readonly CommentThread[]> => {
    const current = ++generation
    changed = new Set()
    removed = new Set()
    status = "loading"
    notify()
    try {
      const list = await transport.list(query)
      // A newer refresh, or a query change, makes this answer stale.
      if (current !== generation) return threads
      const next = new Map<string, CommentThread>()
      for (const thread of list) {
        const local = byId.get(thread.id)
        if (removed.has(thread.id)) continue
        next.set(thread.id, local && local.updatedAt > thread.updatedAt ? local : thread)
      }
      // A thread that someone made or changed while the list was on its way is not in the list yet.
      for (const id of changed) {
        const local = byId.get(id)
        if (local && !next.has(id)) next.set(id, local)
      }
      byId.clear()
      for (const [id, thread] of next) byId.set(id, thread)
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
    if (event.type === "thread") upsert(event.thread)
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
    },
    refresh,
    get: input => transport.get(input),
    create: async input => upsert(await transport.create(input)),
    reply: async input => upsert(await transport.reply(input)),
    edit: async input => upsert(await transport.edit(input)),
    delete: async input => {
      const next = await transport.delete(input)
      if (next) upsert(next)
      else drop(input.threadId)
      return next
    },
    resolve: async input => upsert(await transport.resolve(input)),
    reopen: async input => upsert(await transport.reopen(input)),
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
