import { backoffDelay, createBrowserEnvironment, randomUUID } from "@vite-hub/internal/browser-environment"

import { failedCommentPreparation } from "./client-files.ts"
import { replyMessageId } from "./reply-id.ts"

import type { BrowserEnvironment } from "@vite-hub/internal/browser-environment"
import type {
  CommentCreateInput,
  CommentDelivery,
  CommentDeliveryError,
  CommentFiles,
  CommentMessage,
  CommentReplyInput,
  CommentsTransport,
  CommentSubject,
  CommentThread,
  CommentUser,
} from "./client-types.ts"

/** A message between the tabs of one browser. */
export type CommentsOutboxMessage =
  | { type: "change", account: string }
  | { type: "sent", account: string, id: string, kind: "create" | "reply", key: string, thread: CommentThread }

/** What the outbox needs from the browser: online and visible events, Web Locks, and a BroadcastChannel. Tests pass a fake one. */
export type CommentsOutboxEnvironment = BrowserEnvironment<CommentsOutboxMessage>

interface CommentsOutboxEntryBase {
  id: string
  requestId: string
  account: string
  files: Blob[]
  createdAt: number
  order: number
  status: "pending" | "sending" | "failed"
  error?: CommentDeliveryError
  uncertain?: boolean
  claim?: string
  attempts?: number
  retryAt?: number
  held?: boolean
  uploaded?: string[]
  awaitingFiles?: boolean
}

interface UnsavedDraft {
  entry: CommentsOutboxEntry
  saved: boolean
  parked?: boolean
  write?: Promise<void>
  duplicate?: CommentsOutboxEntry
}

function changeable(entry: CommentsOutboxEntryBase) {
  return entry.status !== "sending" && !entry.uncertain
}

/** A comment or reply that the outbox holds. */
export type CommentsOutboxEntry = CommentsOutboxEntryBase & (
  | { kind: "create", input: Omit<CommentCreateInput, "requestId"> }
  | { kind: "reply", input: Omit<CommentReplyInput, "requestId">, subject?: CommentSubject }
)

/** Where the outbox keeps its entries. The default is IndexedDB, else memory. */
export interface CommentsOutboxStore {
  /** `false` when the entries live only in this page, and a reload loses them. */
  readonly persisted: boolean
  /** The entries of `account`, in queue order. */
  list: (account: string) => Promise<CommentsOutboxEntry[]>
  /** Read and change one account's entries in one transaction. Replace entries rather than mutating them. */
  update: <T>(account: string, change: (entries: Map<string, CommentsOutboxEntry>) => T) => Promise<T>
}

export interface CommentsOutboxOptions {
  /**
   * Who writes, such as the user id or a guest id. Entries of another account stay stored and do not send, so a
   * comment never goes out as somebody else.
   */
  account: string
  /** Separates destinations on the same origin. A custom store must already be scoped to this destination. */
  namespace?: string
  /** Default: the `vitehub-comments` IndexedDB database, else memory with `persisted: false`. */
  store?: CommentsOutboxStore
  /** Default: the browser. */
  environment?: CommentsOutboxEnvironment
}

/** The outbox of a client. `onChange` of the client tells every change. */
export interface CommentsOutbox {
  /** Every entry of the account, in queue order. */
  readonly entries: readonly CommentsOutboxEntry[]
  /** The entries that wait to go out or are going out. */
  readonly queued: readonly CommentsOutboxEntry[]
  /** The entries that the server refused. */
  readonly failures: readonly CommentsOutboxEntry[]
  /** `false` when IndexedDB is not available, so a reload loses the entries. */
  readonly persisted: boolean
  /** Sends the entry again now. Without `id`, resumes pending entries, such as after a sign-in. */
  retry: (id?: string) => Promise<void>
  /** Removes a draft and its waiting replies. `false` if it is gone or the server may already have it. */
  dismiss: (id: string) => Promise<boolean>
  /** Changes a draft and requeues a refused entry. `false` if it is gone or the server may already have it. */
  edit: (id: string, body: string, mentions?: string[]) => Promise<boolean>
  /** Removes every entry of the account, such as at sign-out. */
  clear: () => Promise<void>
}

/** What the outbox needs from its client. */
export interface CommentsOutboxHost {
  transport: CommentsTransport
  user: CommentUser | undefined
  /** The threads that the client holds from the server. */
  threads: () => Iterable<CommentThread>
  /** Puts a thread from the server in the client. */
  upsert: (thread: CommentThread) => void
  /** The entries changed. */
  changed: () => void
}

/**
 * The files of a new comment or reply. With an outbox, `files` may be a promise, such as of a screenshot that renders
 * after Send: the entry shows and saves at once and sends when the promise settles, without files if it rejects.
 */
export type CommentsClientFiles = Omit<CommentFiles, "files"> & { files?: Blob[] | Promise<Blob[]> }

export interface CommentsOutboxEngine extends CommentsOutbox {
  create: (input: CommentCreateInput & CommentsClientFiles) => Promise<CommentThread>
  reply: (input: CommentReplyInput & CommentsClientFiles) => Promise<CommentThread>
  /** The server threads with the waiting replies in them, and the waiting comments as threads of their own. */
  overlay: (threads: readonly CommentThread[]) => { server: CommentThread[], local: CommentThread[] }
  /** Whether the outbox holds the comment `threadId`, or the reply `messageId`. */
  owns: (threadId: string, messageId?: string) => boolean
  beforeResolve: (threadId: string) => Promise<string | undefined>
  start: () => () => void
}

const channel = "vitehub-comments"

function isOutboxMessage(value: unknown): value is CommentsOutboxMessage {
  if (!value || typeof value !== "object") return false
  const type: unknown = Reflect.get(value, "type")
  const account: unknown = Reflect.get(value, "account")
  if (typeof account !== "string") return false
  if (type === "change") return true
  const kind = Reflect.get(value, "kind")
  return type === "sent" && (kind === "create" || kind === "reply") && typeof Reflect.get(value, "id") === "string" && typeof Reflect.get(value, "key") === "string" && Boolean(Reflect.get(value, "thread"))
}

function copyEntry(entry: CommentsOutboxEntry): CommentsOutboxEntry {
  // SAFETY: `JSON.parse` returns what `JSON.stringify` wrote, which has the shape of `input`.
  const input: CommentsOutboxEntry["input"] = JSON.parse(JSON.stringify(entry.input))
  // SAFETY: the copy of `input` keeps the kind of the entry.
  const subject = entry.kind === "reply" && entry.subject ? { kind: entry.subject.kind, id: entry.subject.id } : undefined
  return { ...entry, input, files: [...entry.files], ...(subject ? { subject } : {}), ...(entry.uploaded ? { uploaded: [...entry.uploaded] } : {}), ...(entry.error ? { error: { ...entry.error } } : {}) } as CommentsOutboxEntry
}

function sortEntries(entries: CommentsOutboxEntry[]): CommentsOutboxEntry[] {
  return entries.sort((a, b) => a.order - b.order)
}

/** An outbox store in memory. Entries live as long as the store object. Pass one store to two clients to test a reload. */
export function createMemoryOutboxStore(): CommentsOutboxStore {
  const accounts = new Map<string, Map<string, CommentsOutboxEntry>>()
  return {
    persisted: false,
    async list(account) {
      return sortEntries([...(accounts.get(account)?.values() ?? [])].map(copyEntry))
    },
    async update(account, change) {
      const next = new Map([...(accounts.get(account) ?? [])].map(([id, entry]) => [id, copyEntry(entry)]))
      const result = change(next)
      accounts.set(account, new Map([...next].map(([id, entry]) => [id, copyEntry(entry)])))
      return result
    },
  }
}

const databaseName = "vitehub-comments"
const format = 2

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error("The IndexedDB transaction was aborted."))
    transaction.onerror = () => reject(transaction.error ?? new Error("The IndexedDB transaction failed."))
  })
}

function requested<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("The IndexedDB request failed."))
  })
}

function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, format)
    request.onupgradeneeded = (event) => {
      const drafts = request.result.createObjectStore("drafts", { keyPath: ["account", "id"] })
      drafts.createIndex("account", "account")
      if (event.oldVersion === 1 && request.transaction) {
        const previous = request.transaction.objectStore("outbox").openCursor()
        previous.onsuccess = () => {
          const cursor = previous.result
          if (!cursor) {
            request.result.deleteObjectStore("outbox")
            return
          }
          // SAFETY: Version 1 stored these fields except for the local id and delivery checkpoints.
          const entry = cursor.value as CommentsOutboxEntry
          drafts.put({ ...entry, id: entry.requestId, uncertain: true })
          cursor.continue()
        }
      }
    }
    request.onsuccess = () => {
      const database = request.result
      database.onversionchange = () => database.close()
      resolve(database)
    }
    request.onerror = () => reject(request.error ?? new Error("IndexedDB did not open."))
    request.onblocked = () => reject(new Error("IndexedDB is blocked by another tab."))
  })
}

/**
 * The default store: the `drafts` object store of the `vitehub-comments` IndexedDB database. When IndexedDB is missing or
 * does not open, as in some private windows, it keeps the entries in memory and `persisted` is `false`.
 */
export function createIndexedDBOutboxStore(): CommentsOutboxStore {
  return indexedDBOutboxStore(databaseName)
}

function indexedDBOutboxStore(name: string): CommentsOutboxStore {
  let backend: Promise<{ database: IDBDatabase } | { memory: CommentsOutboxStore }> | undefined
  let persisted = typeof indexedDB !== "undefined"
  const open = () => backend ??= (persisted ? openDatabase(name) : Promise.reject(new Error("No IndexedDB.")))
    .then(database => ({ database }), () => {
      persisted = false
      return { memory: createMemoryOutboxStore() }
    })
  const run = async <T>(memory: (store: CommentsOutboxStore) => Promise<T>, database: (database: IDBDatabase) => Promise<T>): Promise<T> => {
    const opened = await open()
    return "database" in opened ? database(opened.database) : memory(opened.memory)
  }
  return {
    get persisted() {
      return persisted
    },
    list: account => run(store => store.list(account), async (database) => {
      const transaction = database.transaction("drafts", "readonly")
      const entries = await requested<CommentsOutboxEntry[]>(transaction.objectStore("drafts").index("account").getAll(account))
      return sortEntries(entries)
    }),
    update: (account, change) => run(store => store.update(account, change), async (database) => {
      const transaction = database.transaction("drafts", "readwrite")
      const drafts = transaction.objectStore("drafts")
      const read = drafts.index("account").getAll(account)
      const complete = done(transaction)
      const result = new Promise<ReturnType<typeof change>>((resolve, reject) => {
        read.onsuccess = () => {
          // SAFETY: The account index only returns records written by this store.
          const previous = new Map((read.result as CommentsOutboxEntry[]).map(entry => [entry.id, entry]))
          const next = new Map(previous)
          try {
            const value = change(next)
            for (const id of previous.keys()) if (!next.has(id)) drafts.delete([account, id])
            for (const [id, entry] of next) if (previous.get(id) !== entry) drafts.put(copyEntry(entry))
            resolve(value)
          }
          catch (error) {
            reject(error)
            transaction.abort()
          }
        }
        read.onerror = () => reject(read.error)
      })
      return (await Promise.all([result, complete]))[0]
    }),
  }
}

function deliveryError(error: unknown): CommentDeliveryError & { retryAfter?: number } {
  const field = (name: string): unknown => error && typeof error === "object" ? Reflect.get(error, name) : undefined
  const status = field("status")
  const code = field("code")
  const why = field("why") ?? field("message")
  const fix = field("fix")
  const retryAfter = field("retryAfter")
  return {
    status: typeof status === "number" ? status : 0,
    why: typeof why === "string" && why ? why : String(error),
    ...(typeof code === "string" ? { code } : {}),
    ...(typeof fix === "string" ? { fix } : {}),
    ...(typeof retryAfter === "number" && retryAfter >= 0 ? { retryAfter } : {}),
  }
}

function outcomeOf(status: number): "wait" | "hold" | "fail" {
  if (status === 401 || status === 402) return "hold"
  if (status === 408 || status === 429) return "wait"
  return status >= 400 && status < 500 ? "fail" : "wait"
}

/** The outbox of one client. */
export function createOutbox(options: CommentsOutboxOptions, host: CommentsOutboxHost): CommentsOutboxEngine {
  const { account, namespace } = options
  const scopedChannel = namespace === undefined ? channel : `${channel}:${JSON.stringify(namespace)}`
  const store = options.store ?? (!options.environment && !globalThis.navigator?.locks ? createMemoryOutboxStore() : indexedDBOutboxStore(scopedChannel))
  const environment = options.environment ?? createBrowserEnvironment({ channel: scopedChannel, isMessage: isOutboxMessage })
  const queue = namespace === undefined ? account : JSON.stringify([namespace, account])
  const lockName = `vitehub-comments-outbox:${queue}`
  const filesLock = (id: string): string => `vitehub-comments-files:${queue}:${id}`
  let entries: CommentsOutboxEntry[] = []
  let stored: CommentsOutboxEntry[] = []
  const unsaved = new Map<string, UnsavedDraft>()
  const arriving = new Map<string, Promise<void>>()
  const blockedFiles = new Map<string, { files: Blob[], error: CommentDeliveryError, resume: () => void }>()
  const aliases = new Map<string, string>()
  const entryId = (id: string) => aliases.get(id) ?? id
  const queueListeners = new Set<() => void>()
  const queueChanged = () => { for (const listener of queueListeners) listener() }
  const written = new Set<string>()
  let lastOrder = 0
  const sent = new Map<string, CommentThread>()
  const receipts = new Map<string, CommentThread>()
  const keyOf = (entry: CommentsOutboxEntry): string => entry.kind === "create"
    ? JSON.stringify([entry.kind, entry.input.subject.kind, entry.input.subject.id, entry.requestId])
    : JSON.stringify([entry.kind, entry.input.threadId, entry.requestId])
  const replyKey = (threadId: string, requestId: string): string => JSON.stringify([threadId, requestId])
  let replyIds = new Map<string, string>()
  let loading: Promise<void> = Promise.resolve()
  let leading: { giveUp: () => void } | undefined
  let again = false
  let stopped = false
  let cancelWait: (() => void) | undefined

  const post = (message: CommentsOutboxMessage): void => environment.post(message)
  const reload = (): Promise<void> => loading = loading.catch(() => undefined).then(async () => {
    const landed = [...unsaved].flatMap(([id, local]) => local.saved ? [id] : [])
    const pending = await store.list(account)
    const ids = new Map<string, string>()
    if (globalThis.crypto?.subtle) {
      await Promise.all(pending.map(async (entry) => {
        if (entry.kind !== "reply") return
        const threadId = realId(entry.input.threadId)
        const key = replyKey(threadId, entry.requestId)
        ids.set(key, replyIds.get(key) ?? await replyMessageId(threadId, entry.requestId))
      }))
    }
    replyIds = ids
    stored = pending
    for (const id of landed) unsaved.delete(id)
    merge()
  })
  const merge = (): void => {
    const ids = new Set(stored.map(entry => entry.id))
    entries = sortEntries([...stored, ...[...unsaved.values()].flatMap(local => ids.has(local.entry.id) || local.duplicate ? [] : [local.entry])]).map((entry) => {
      const blocked = blockedFiles.get(entry.id)
      return blocked ? { ...entry, status: "failed", files: [...entry.files, ...blocked.files], error: blocked.error } : entry
    })
    guardUnload((!store.persisted && entries.length > 0) || blockedFiles.size > 0 || [...unsaved.values()].some(local => !local.saved))
    host.changed()
    queueChanged()
  }
  let guarded = false
  const holdPage = (event: Event): void => {
    event.preventDefault()
    Reflect.set(event, "returnValue", "")
  }
  const guardUnload = (on: boolean): void => {
    if (on === guarded || typeof globalThis.addEventListener !== "function") return
    guarded = on
    if (on) globalThis.addEventListener("beforeunload", holdPage)
    else globalThis.removeEventListener("beforeunload", holdPage)
  }
  const changed = async (): Promise<void> => {
    await reload()
    post({ type: "change", account: queue })
  }

  const serverThread = (id: string): CommentThread | undefined => {
    for (const thread of host.threads()) if (thread.id === id) return thread
    return undefined
  }
  const realId = (threadId: string): string => {
    const id = entryId(threadId)
    return sent.get(id)?.id ?? id
  }

  const delivery = (entry: CommentsOutboxEntry): CommentDelivery => ({
    status: entry.status === "failed" ? "failed" : "pending",
    requestId: entry.requestId,
    files: entry.files,
    ...(entry.error ? { error: entry.error } : {}),
  })
  const author = (): CommentUser => host.user?.id === account ? host.user : { id: account }
  const localMessage = (entry: CommentsOutboxEntry, threadId: string): CommentMessage => ({
    id: entry.id,
    threadId,
    body: entry.input.body,
    author: author(),
    mentions: entry.input.mentions ?? [],
    attachments: entry.input.attachments ?? [],
    createdAt: entry.createdAt,
    delivery: delivery(entry),
  })

  const overlay = (threads: readonly CommentThread[]) => {
    const replies = new Map<string, CommentsOutboxEntry[]>()
    for (const entry of entries) {
      if (entry.kind !== "reply") continue
      const id = realId(entry.input.threadId)
      replies.set(id, [...(replies.get(id) ?? []), entry])
    }
    const withReplies = (thread: CommentThread): CommentThread => {
      const waiting = replies.get(thread.id)
      if (!waiting) return thread
      const have = new Set(thread.messages.filter(message => message.author.id === account).map(message => message.id))
      const added = waiting.filter((entry) => {
        const id = thread.delivery ? undefined : replyIds.get(replyKey(thread.id, entry.requestId))
        return !(id && have.has(id))
      }).map(entry => localMessage(entry, thread.id))
      return added.length ? { ...thread, messages: [...thread.messages, ...added] } : thread
    }
    const server = threads.map(withReplies)
    const local: CommentThread[] = []
    for (const entry of entries) {
      if (entry.kind !== "create" || sent.has(entry.id) || threads.some(thread => matchesCreate(entry, thread))) continue
      local.push(withReplies(localThread(entry)))
    }
    return { server, local }
  }
  const matchesCreate = (entry: CommentsOutboxEntry & { kind: "create" }, thread: CommentThread): boolean => thread.requestId === entry.requestId
    && thread.author.id === account && thread.subject.kind === entry.input.subject.kind && thread.subject.id === entry.input.subject.id
  const localThread = (entry: CommentsOutboxEntry & { kind: "create" }): CommentThread => {
    const { input } = entry
    return {
      id: entry.id,
      scope: "",
      n: 0,
      subject: input.subject,
      anchor: input.anchor,
      status: "open",
      author: author(),
      messages: [localMessage(entry, entry.id)],
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      ...(input.revision === undefined ? {} : { revision: input.revision }),
      createdAt: entry.createdAt,
      updatedAt: entry.createdAt,
      requestId: entry.requestId,
      delivery: delivery(entry),
    }
  }

  const next = (list: readonly CommentsOutboxEntry[]): CommentsOutboxEntry | undefined => {
    const waiting = new Set([...list, ...[...unsaved.values()].map(local => local.entry)].flatMap(entry => entry.kind === "create" ? [entry.id] : []))
    return list.find(entry => entry.status !== "failed" && !(entry.kind === "reply" && waiting.has(entry.input.threadId)))
  }
  const saving = (order: number): boolean => [...unsaved.values()].some(local => !local.saved && !local.parked && local.entry.status !== "failed" && local.entry.order < order)
  const aborted = (signal: AbortSignal): Promise<void> => new Promise((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener("abort", () => resolve(), { once: true })
  })

  const wait = (ms: number): void => {
    cancelWait?.()
    cancelWait = environment.schedule(() => {
      cancelWait = undefined
      kick()
    }, ms)
  }

  const update = <T>(change: (drafts: Map<string, CommentsOutboxEntry>) => T): Promise<T> => store.update(account, change)
  const send = async (entry: CommentsOutboxEntry): Promise<void> => {
    const withClaim = <T>(change: (current: CommentsOutboxEntry, drafts: Map<string, CommentsOutboxEntry>) => T) => update((drafts) => {
      const current = drafts.get(entry.id)
      if (current && current.claim === entry.claim) return change(current, drafts)
    })
    let thread: CommentThread
    let writing = false
    const outbox: NonNullable<CommentFiles["outbox"]> = {
      account,
      async uploaded(key) {
        const saved = await withClaim((current, drafts) => drafts.set(entry.id, { ...current, uploaded: [...(current.uploaded ?? []), key] }))
        if (!saved) throw new DOMException("This draft is no longer in the outbox.", "AbortError")
      },
    }
    try {
      const files: CommentFiles = {
        files: entry.files.slice(entry.uploaded?.length ?? 0),
        outbox,
      }
      const attachments = [...(entry.input.attachments ?? []), ...(entry.uploaded ?? [])]
      const extra = { ...files, requestId: entry.requestId, ...(attachments.length ? { attachments } : {}) }
      if (entry.kind === "create") {
        if (!await withClaim(() => true)) return
        writing = true
        thread = await host.transport.create({ ...entry.input, ...extra })
      }
      else {
        const threadId = realId(entry.input.threadId)
        const subject = entry.subject ?? serverThread(threadId)?.subject ?? (files.files?.length ? (await host.transport.get({ threadId }))?.subject : undefined)
        if (files.files?.length && !subject) throw Object.assign(new Error("The thread for this reply does not exist."), { status: 404 })
        if (!await withClaim(() => true)) return
        writing = true
        thread = await host.transport.reply({ ...entry.input, ...extra, threadId, ...(subject ? { subject } : {}) })
      }
    }
    catch (cause) {
      const preparation = failedCommentPreparation.get(outbox)
      const beforeWrite = preparation !== undefined && Object.is(preparation.cause, cause)
      const { retryAfter, ...error } = deliveryError(cause)
      const outcome = outcomeOf(error.status)
      const attempts = entry.attempts ?? 0
      const saved = await withClaim((current, drafts) => drafts.set(entry.id, {
        ...current,
        status: outcome === "fail" ? "failed" : "pending",
        uncertain: entry.uncertain || (writing && !beforeWrite && outcome === "wait" && error.status !== 429),
        held: outcome === "hold",
        retryAt: outcome === "wait" ? Date.now() + Math.max(1, retryAfter ?? backoffDelay(attempts, environment.random())) : undefined,
        attempts: attempts + 1,
        error,
      }))
      if (saved) await changed()
      return
    }
    const removed = await withClaim((current, drafts) => {
      if (current.kind === "create") {
        for (const reply of drafts.values()) {
          if (reply.kind === "reply" && reply.input.threadId === entry.id) {
            drafts.set(reply.id, { ...reply, subject: thread.subject, input: { ...reply.input, threadId: thread.id } })
          }
        }
      }
      return drafts.delete(entry.id)
    })
    if (!removed) return
    const key = keyOf(entry)
    if (entry.kind === "create") sent.set(entry.id, thread)
    receipts.set(key, thread)
    host.upsert(thread)
    await reload()
    post({ type: "sent", account: queue, id: entry.id, kind: entry.kind, key, thread })
  }

  const drain = async (signal: AbortSignal): Promise<void> => {
    cancelWait?.()
    cancelWait = undefined
    while (!signal.aborted && environment.isOnline()) {
      const claim = randomUUID()
      const selected = await update((drafts): { delay: number } | { files: string } | { claimed: CommentsOutboxEntry } | undefined => {
        if (signal.aborted) return
        const entry = next(sortEntries([...drafts.values()]))
        if (!entry || entry.held || saving(entry.order)) return
        if (entry.awaitingFiles) return { files: entry.id }
        const delay = (entry.retryAt ?? 0) - Date.now()
        if (delay > 0) return { delay }
        const claimed = { ...entry, claim, status: "sending" as const, uncertain: entry.uncertain || entry.status === "sending" }
        drafts.set(entry.id, claimed)
        return { claimed }
      })
      if (!selected) return
      if ("delay" in selected) {
        wait(selected.delay)
        return
      }
      if ("files" in selected) {
        if (arriving.has(selected.files)) return
        await Promise.race([environment.lock(filesLock(selected.files), async () => undefined), aborted(signal)])
        if (signal.aborted) return
        await update((drafts) => {
          const current = drafts.get(selected.files)
          if (current?.awaitingFiles && !arriving.has(current.id)) drafts.set(current.id, { ...current, awaitingFiles: false })
        })
        await changed()
        continue
      }
      await reload()
      await send(selected.claimed)
    }
  }

  function kick(): void {
    if (stopped) return
    if (leading) {
      again = true
      return
    }
    const run = { giveUp: () => undefined as void }
    leading = run
    run.giveUp = environment.lead(lockName, async (signal) => {
      try {
        do {
          again = false
          await drain(signal)
        } while (again && !signal.aborted)
      }
      finally {
        if (leading === run) leading = undefined
      }
    })
  }

  const save = (id: string): Promise<void> => {
    const local = unsaved.get(id)
    if (!local) return Promise.resolve()
    const run = async (): Promise<void> => {
      local.parked = false
      let group = [local]
      try {
        const parked = await update((drafts) => {
          if (unsaved.get(id) !== local) return false
          if (local.entry.kind === "reply") local.entry = { ...local.entry, input: { ...local.entry.input, threadId: realId(local.entry.input.threadId) } }
          const parent = local.entry.kind === "reply" ? unsaved.get(local.entry.input.threadId) : undefined
          if (parent && !parent.saved && !drafts.has(parent.entry.id)) return true
          let order = local.entry.order
          for (const draft of drafts.values()) if (!written.has(draft.id)) order = Math.max(order, draft.order + 1)
          const later = [...unsaved.values()].filter(other => other !== local && !drafts.has(other.entry.id) && other.entry.order > local.entry.order)
          let previous = order
          for (const other of later.sort((a, b) => a.entry.order - b.entry.order)) {
            previous = Math.max(other.entry.order, previous + 1)
            other.entry = { ...other.entry, order: previous }
          }
          lastOrder = Math.max(lastOrder, previous)
          local.entry = { ...local.entry, order }
          group = [local, ...[...unsaved.values()].filter(other => other.parked && other.entry.kind === "reply" && other.entry.input.threadId === id)]
          for (const member of group) member.write ??= write
          const keys = new Map([...drafts.values()].map(draft => [keyOf(draft), draft]))
          for (const member of group) {
            if (member.entry.kind === "reply") member.entry = { ...member.entry, input: { ...member.entry.input, threadId: realId(member.entry.input.threadId) } }
            const key = keyOf(member.entry)
            const duplicate = keys.get(key)
            if (duplicate) {
              member.duplicate = duplicate
              aliases.set(member.entry.id, duplicate.id)
            }
            else {
              drafts.set(member.entry.id, member.entry)
              keys.set(key, member.entry)
            }
          }
          return false
        })
        if (parked) {
          local.parked = true
          return
        }
      }
      catch (cause) {
        local.entry = { ...local.entry, status: "failed", error: deliveryError(cause) }
        merge()
        kick()
        return
      }
      finally {
        for (const member of group) if (member.write === write) member.write = undefined
      }
      for (const member of group) Object.assign(member, { saved: true, parked: false })
      await changed().catch(() => undefined)
      kick()
    }
    const write = Promise.resolve().then(run)
    local.write = write
    return write
  }
  const add = (entry: CommentsOutboxEntry, files: Blob[] | Promise<Blob[]> | undefined) => {
    const later = files !== undefined && !Array.isArray(files)
    const order = Math.max(Date.now(), lastOrder + 1, ...entries.map(other => other.order + 1))
    lastOrder = order
    written.add(entry.id)
    const local: UnsavedDraft = { entry: copyEntry({ ...entry, order, ...(later ? { awaitingFiles: true } : {}) }), saved: false }
    unsaved.set(entry.id, local)
    if (later) arrive(entry.id, Promise.resolve(files))
    merge()
    return { local, write: save(entry.id) }
  }
  const queueEntry = (entry: CommentsOutboxEntry, files: Blob[] | Promise<Blob[]> | undefined) => {
    const existing = entries.find(draft => keyOf(draft) === keyOf(entry))
    if (!existing) return { entry, ...add(entry, files) }
    const local = unsaved.get(existing.id)
    return { entry: existing, local, write: local?.write }
  }
  const arrive = (id: string, files: Promise<Blob[]>): void => {
    const arrival = environment.lock(filesLock(id), async () => {
      const arrived = await files.then(list => [...list], () => [])
      const local = unsaved.get(id)
      await local?.write
      const settled = (entry: CommentsOutboxEntry): CommentsOutboxEntry => ({ ...entry, files: [...entry.files, ...arrived], awaitingFiles: false })
      if (local && !local.saved) {
        local.entry = settled(local.entry)
        merge()
        return
      }
      while (arriving.has(id)) {
        try {
          await update((drafts) => {
            const current = drafts.get(id)
            if (current?.awaitingFiles) drafts.set(id, settled(current))
          })
          break
        }
        catch (cause) {
          if (!arriving.has(id)) break
          const retry = new Promise<void>((resume) => {
            blockedFiles.set(id, { files: arrived, error: deliveryError(cause), resume })
          })
          merge()
          await retry
        }
      }
    }).catch(() => undefined).then(async () => {
      arriving.delete(id)
      blockedFiles.delete(id)
      await changed().catch(() => undefined)
      kick()
    })
    arriving.set(id, arrival)
  }
  const unsavedEntry = async (id: string) => {
    await unsaved.get(id)?.write
    const local = unsaved.get(id)
    return local && !local.saved ? local : undefined
  }
  const fields = (requestId: string | undefined, files: Blob[] | Promise<Blob[]> | undefined) => {
    const now = Date.now()
    const id = randomUUID()
    return {
      id,
      requestId: requestId ?? id,
      account,
      files: Array.isArray(files) ? [...files] : [],
      createdAt: now,
      order: now,
      status: "pending" as const,
    }
  }

  void reload()

  return {
    get entries() {
      return entries
    },
    get queued() {
      return entries.filter(entry => entry.status !== "failed")
    },
    get failures() {
      return entries.filter(entry => entry.status === "failed")
    },
    get persisted() {
      return store.persisted
    },
    overlay,
    owns: (threadId, messageId) => entries.some(entry => entry.id === entryId(messageId ?? threadId)),
    async beforeResolve(threadId) {
      await reload()
      while (true) {
        const id = realId(threadId)
        const pending = entries.filter(entry => entry.id === id || (entry.kind === "reply" && realId(entry.input.threadId) === id))
        if (!pending.length) return id
        if (stopped || !environment.isOnline() || pending.some(entry => entry.held || entry.status === "failed" || entry.retryAt !== undefined) || entries.some(entry => entry.held)) return
        await new Promise<void>((resolve) => {
          const wake = () => { queueListeners.delete(wake); resolve() }
          queueListeners.add(wake)
        })
      }
    },
    async create({ files, requestId, ...input }) {
      const entry = { ...fields(requestId, files), kind: "create" as const, input }
      const receipt = () => receipts.get(keyOf(entry)) ?? [...host.threads()].find(thread => matchesCreate(entry, thread))
      const earlier = receipt()
      if (earlier) return earlier
      const queued = queueEntry(entry, files)
      if (requestId !== undefined) {
        await queued.write
        const confirmed = receipt()
        if (confirmed) return confirmed
      }
      const saved = queued.local?.duplicate ?? entries.find(draft => draft.id === queued.entry.id) ?? queued.entry
      return localThread(saved.kind === "create" ? saved : entry)
    },
    async reply({ files, requestId, subject, ...input }) {
      const threadId = realId(input.threadId)
      const parent = entries.find(entry => entry.kind === "create" && entry.id === threadId)
      const cached = serverThread(threadId)
      const target = subject ?? cached?.subject ?? (parent?.kind === "create" ? parent.input.subject : undefined)
      const entry = { ...fields(requestId, files), kind: "reply" as const, input: { ...input, threadId }, ...(target ? { subject: target } : {}) }
      const earlier = receipts.get(keyOf(entry))
      if (earlier) return serverThread(earlier.id) ?? earlier
      const queued = queueEntry(entry, files)
      if (requestId !== undefined) await queued.write
      const saved = queued.local?.duplicate ?? queued.local?.entry ?? queued.entry
      const confirmed = receipts.get(keyOf(saved))
      if (confirmed) return serverThread(confirmed.id) ?? confirmed
      const resolvedId = realId(threadId)
      const thread = serverThread(resolvedId) ?? cached
      if (thread) return overlay([thread]).server[0] ?? thread
      const local = overlay([]).local.find(local => local.id === resolvedId)
      if (local) return local
      return { id: resolvedId, scope: "", n: 0, subject: target ?? { kind: "", id: "" }, anchor: { kind: "page" }, status: "open", author: author(), messages: [localMessage(saved, resolvedId)], createdAt: entry.createdAt, updatedAt: entry.createdAt }
    },
    async retry(id) {
      if (id !== undefined) {
        id = entryId(id)
        const blocked = blockedFiles.get(id)
        if (blocked) {
          blocked.resume()
          return
        }
      }
      const local = id === undefined ? undefined : await unsavedEntry(id)
      if (local) {
        local.entry = { ...local.entry, status: "pending", error: undefined }
        merge()
        await save(local.entry.id)
        return
      }
      await update((drafts) => {
        for (const entry of drafts.values()) {
          if (entry.status === "sending" || (id !== undefined && entry.id !== id)) continue
          if (entry.status === "failed" && id === undefined) continue
          drafts.set(entry.id, { ...entry, status: "pending", held: false, attempts: 0, retryAt: undefined, error: undefined })
        }
      })
      await changed()
      kick()
    },
    async dismiss(id) {
      id = entryId(id)
      if (await unsavedEntry(id)) {
        for (const [other, local] of unsaved) if (other === id || (local.entry.kind === "reply" && local.entry.input.threadId === id)) unsaved.delete(other)
        await update((drafts) => {
          for (const reply of drafts.values()) if (reply.kind === "reply" && reply.input.threadId === id) drafts.delete(reply.id)
        })
        await changed()
        kick()
        return true
      }
      const removed = await update((drafts) => {
        const entry = drafts.get(id)
        if (!entry || !changeable(entry)) return false
        if (entry.kind === "create") {
          for (const reply of drafts.values()) if (reply.kind === "reply" && reply.input.threadId === id) drafts.delete(reply.id)
        }
        return drafts.delete(id)
      })
      if (removed) {
        arriving.delete(id)
        blockedFiles.get(id)?.resume()
        await changed()
        kick()
      }
      return removed
    },
    async edit(id, body, mentions) {
      id = entryId(id)
      const local = await unsavedEntry(id)
      if (local) {
        const input = { ...local.entry.input, body, ...(mentions ? { mentions } : {}) }
        // SAFETY: `input` keeps the kind of the entry.
        local.entry = { ...local.entry, input, status: "pending", error: undefined } as CommentsOutboxEntry
        merge()
        await save(id)
        return true
      }
      const edited = await update((drafts) => {
        const entry = drafts.get(id)
        if (!entry || !changeable(entry)) return false
        const fields = { body, ...(mentions ? { mentions } : {}) }
        if (entry.kind === "create") drafts.set(id, { ...entry, input: { ...entry.input, ...fields }, status: "pending", error: undefined })
        else drafts.set(id, { ...entry, input: { ...entry.input, ...fields }, status: "pending", error: undefined })
        return true
      })
      if (edited) {
        await changed()
        kick()
      }
      return edited
    },
    async clear() {
      cancelWait?.()
      cancelWait = undefined
      unsaved.clear()
      await update(drafts => drafts.clear())
      arriving.clear()
      for (const blocked of blockedFiles.values()) blocked.resume()
      blockedFiles.clear()
      aliases.clear()
      sent.clear()
      receipts.clear()
      await changed()
    },
    start() {
      stopped = false
      const stops = [
        environment.listen((event) => {
          if (event === "offline") queueChanged()
          if (event !== "online" && event !== "visible") return
          void update((drafts) => {
            for (const entry of drafts.values()) {
              if (entry.status === "pending" && entry.retryAt !== undefined) drafts.set(entry.id, { ...entry, retryAt: undefined })
            }
          }).then(changed).then(kick)
        }),
        environment.receive((message) => {
          if (message.account !== queue) return
          if (message.type === "sent") {
            if (message.kind === "create") sent.set(message.id, message.thread)
            receipts.set(message.key, message.thread)
            host.upsert(message.thread)
          }
          void reload()
        }),
      ]
      void reload()
      kick()
      return () => {
        for (const stop of stops.splice(0)) stop()
        stopped = true
        queueChanged()
        cancelWait?.()
        cancelWait = undefined
        leading?.giveUp()
        leading = undefined
      }
    },
  }
}
