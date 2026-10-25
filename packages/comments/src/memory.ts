import { commentsErrorDiagnostics } from "./errors.ts"
import type {
  CommentEvent,
  CommentListQuery,
  CommentMessage,
  CommentSubject,
  CommentsTransport,
  CommentThread,
  CommentUser,
} from "./types.ts"

export interface MemoryTransportOptions {
  /** The signed-in user. Every call acts as this user. */
  user: CommentUser
  /** People that `users()` can find, for @mentions. */
  users?: CommentUser[]
  /** Threads to start with. */
  threads?: CommentThread[]
  /** The numbering scope of a subject. Defaults to one scope for the whole site. */
  scope?: (subject: CommentSubject) => string
  now?: () => number
}

export interface MemoryTransport extends CommentsTransport {
  readonly user: CommentUser
  /** A copy of every thread in the store. */
  readonly threads: CommentThread[]
  subscribe: NonNullable<CommentsTransport["subscribe"]>
  /** Another person on the same store, to test what each one sees and may change. */
  as: (user: CommentUser) => MemoryTransport
}

interface Store {
  threads: Map<string, CommentThread>
  listeners: Set<(event: CommentEvent) => void>
  counters: Map<string, number>
  users: CommentUser[]
  scope: (subject: CommentSubject) => string
  now: () => number
  ids: number
}

// Callers may hand over reactive proxies, which `structuredClone` rejects. Comments are JSON by contract.
function copy<T>(value: T): T {
  // SAFETY: `JSON.parse` returns what `JSON.stringify` wrote, which has the shape of `value`.
  const clone: T = JSON.parse(JSON.stringify(value))
  return clone
}

function sameSubject(a: CommentSubject, b: CommentSubject): boolean {
  return a.kind === b.kind && a.id === b.id
}

/**
 * A transport that keeps threads in memory. Use it in tests, in docs examples, and to try the UI
 * before the server half exists. It follows the access rules of the real operations: authors edit
 * and delete their own messages, and everyone can resolve.
 */
export function createMemoryTransport(options: MemoryTransportOptions): MemoryTransport {
  const store: Store = {
    threads: new Map(),
    listeners: new Set(),
    counters: new Map(),
    users: options.users ?? [],
    scope: options.scope ?? (() => "site"),
    now: options.now ?? Date.now,
    ids: 0,
  }
  for (const thread of options.threads ?? []) {
    store.threads.set(thread.id, copy(thread))
    store.counters.set(thread.scope, Math.max(store.counters.get(thread.scope) ?? 0, thread.n))
  }
  return view(store, options.user)
}

function emit(store: Store, event: CommentEvent): void {
  for (const listener of store.listeners) listener(copy(event))
}

function thread(store: Store, id: string): CommentThread {
  const found = store.threads.get(id)
  if (!found) throw commentsErrorDiagnostics.COMMENTS_R0002({ id })
  return found
}

function message(store: Store, user: CommentUser, input: { threadId: string, body: string, mentions?: string[], attachments?: string[] }): CommentMessage {
  const body = input.body.trim()
  if (!body) throw commentsErrorDiagnostics.COMMENTS_R0005()
  return {
    id: `message-${++store.ids}`,
    threadId: input.threadId,
    body,
    author: copy(user),
    mentions: input.mentions ?? [],
    attachments: input.attachments ?? [],
    createdAt: store.now(),
  }
}

function view(store: Store, user: CommentUser): MemoryTransport {
  const save = (next: CommentThread): CommentThread => {
    next.updatedAt = store.now()
    store.threads.set(next.id, next)
    emit(store, { type: "thread", thread: next })
    return copy(next)
  }
  const matches = (item: CommentThread, query: CommentListQuery): boolean => {
    if (query.subject && !sameSubject(item.subject, query.subject)) return false
    if (query.page !== undefined && !sameSubject(item.subject, { kind: "page", id: query.page })) return false
    if (query.status && item.status !== query.status) return false
    if (query.mine && item.author.id !== user.id) return false
    if (query.mentions && !item.messages.some(entry => entry.mentions.includes(user.id))) return false
    return true
  }
  return {
    user,
    get threads() {
      return [...store.threads.values()].map(copy)
    },
    as: other => view(store, other),
    async list(query) {
      return [...store.threads.values()].filter(item => matches(item, query)).sort((a, b) => a.n - b.n).map(copy)
    },
    async get(input) {
      const found = "id" in input
        ? store.threads.get(input.id)
        : [...store.threads.values()].find(item => item.n === input.n && (input.scope === undefined || item.scope === input.scope))
      return found ? copy(found) : null
    },
    async create(input) {
      const scope = store.scope(input.subject)
      const n = (store.counters.get(scope) ?? 0) + 1
      const id = `thread-${++store.ids}`
      const first = message(store, user, { ...input, threadId: id })
      store.counters.set(scope, n)
      return save({
        id,
        scope,
        n,
        subject: copy(input.subject),
        anchor: copy(input.anchor),
        status: "open",
        author: copy(user),
        messages: [first],
        createdAt: first.createdAt,
        updatedAt: first.createdAt,
      })
    },
    async reply(input) {
      const found = copy(thread(store, input.threadId))
      found.messages.push(message(store, user, input))
      return save(found)
    },
    async edit(input) {
      const found = copy(thread(store, input.threadId))
      const target = found.messages.find(entry => entry.id === input.messageId)
      if (!target) throw commentsErrorDiagnostics.COMMENTS_R0003({ messageId: input.messageId })
      if (target.author.id !== user.id) throw commentsErrorDiagnostics.COMMENTS_R0004()
      const body = input.body.trim()
      if (!body) throw commentsErrorDiagnostics.COMMENTS_R0005()
      target.body = body
      target.mentions = input.mentions ?? target.mentions
      target.editedAt = store.now()
      return save(found)
    },
    async delete(input) {
      const found = copy(thread(store, input.threadId))
      const target = input.messageId === undefined ? undefined : found.messages.find(entry => entry.id === input.messageId)
      if (input.messageId !== undefined && !target) throw commentsErrorDiagnostics.COMMENTS_R0003({ messageId: input.messageId })
      if ((target ?? found).author.id !== user.id) throw commentsErrorDiagnostics.COMMENTS_R0004()
      if (!target || target === found.messages[0]) {
        store.threads.delete(found.id)
        emit(store, { type: "deleted", threadId: found.id })
        return null
      }
      found.messages = found.messages.filter(entry => entry !== target)
      return save(found)
    },
    async resolve(input) {
      const found = copy(thread(store, input.threadId))
      found.status = "resolved"
      found.resolvedBy = copy(user)
      found.resolvedAt = store.now()
      return save(found)
    },
    async reopen(input) {
      const found = copy(thread(store, input.threadId))
      found.status = "open"
      delete found.resolvedBy
      delete found.resolvedAt
      return save(found)
    },
    async users(input) {
      const query = input.query.trim().toLowerCase()
      return store.users
        .filter(person => person.name.toLowerCase().includes(query))
        .slice(0, input.limit ?? 5)
        .map(copy)
    },
    subscribe(listener) {
      store.listeners.add(listener)
      return () => {
        store.listeners.delete(listener)
      }
    },
  }
}
