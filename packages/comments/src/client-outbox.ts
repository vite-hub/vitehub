// The saved outbox of `createCommentsClient({ outbox })`. Each new comment and reply is stored with its files before it
// shows, and goes to the server one at a time, in order, with its `requestId` as the retry key. One tab sends at a time.
import { backoffDelay, createBrowserEnvironment, randomUUID } from "@vite-hub/internal/browser-environment"

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
  | { type: "sent", account: string, requestId: string, thread: CommentThread }

/** What the outbox needs from the browser: online and visible events, Web Locks, and a BroadcastChannel. Tests pass a fake one. */
export type CommentsOutboxEnvironment = BrowserEnvironment<CommentsOutboxMessage>

interface CommentsOutboxEntryBase {
  /** The retry key that the server gets. A local thread or message has it as its `id`. */
  requestId: string
  account: string
  files: Blob[]
  /** Milliseconds since the epoch. */
  createdAt: number
  /** The place in the queue. */
  order: number
  /** `sending` while one tab sends it. `failed` when the server refused it: it waits for `retry`, `edit`, or `dismiss`. */
  status: "pending" | "sending" | "failed"
  /** Why the last try did not go out. */
  error?: CommentDeliveryError
}

/** A comment or reply that the outbox holds. */
export type CommentsOutboxEntry = CommentsOutboxEntryBase & (
  | { kind: "create", input: Omit<CommentCreateInput, "requestId"> }
  | { kind: "reply", input: Omit<CommentReplyInput, "requestId"> }
)

/** Where the outbox keeps its entries. The default is IndexedDB, else memory. */
export interface CommentsOutboxStore {
  /** `false` when the entries live only in this page, and a reload loses them. */
  readonly persisted: boolean
  /** The entries of `account`, in queue order. */
  list: (account: string) => Promise<CommentsOutboxEntry[]>
  get: (requestId: string) => Promise<CommentsOutboxEntry | undefined>
  put: (entry: CommentsOutboxEntry) => Promise<void>
  delete: (requestIds: readonly string[]) => Promise<void>
}

export interface CommentsOutboxOptions {
  /**
   * Who writes, such as the user id or a guest id. Entries of another account stay stored and do not send, so a
   * comment never goes out as somebody else.
   */
  account: string
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
  /** Sends the entry again now. Without `requestId`, the whole queue tries again, such as after a sign-in. */
  retry: (requestId?: string) => Promise<void>
  /** Removes the entry, and the replies to a comment that never went out. `false` when it is going out now, or gone. */
  dismiss: (requestId: string) => Promise<boolean>
  /** Changes the text before it goes out. A refused entry goes back in the queue. `false` when it is going out now, or gone. */
  edit: (requestId: string, body: string, mentions?: string[]) => Promise<boolean>
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

export interface CommentsOutboxEngine extends CommentsOutbox {
  create: (input: CommentCreateInput & CommentFiles) => Promise<CommentThread>
  /** `null` when the client does not hold the thread, so there is nothing to show the reply in, and nothing was saved. */
  reply: (input: CommentReplyInput & CommentFiles) => Promise<CommentThread | null>
  /** The server threads with the waiting replies in them, and the waiting comments as threads of their own. */
  overlay: (threads: readonly CommentThread[]) => { server: CommentThread[], local: CommentThread[] }
  /** Whether the outbox holds the comment `threadId`, or the reply `messageId`. */
  owns: (threadId: string, messageId?: string) => boolean
  start: () => () => void
}

const channel = "vitehub-comments"

function isOutboxMessage(value: unknown): value is CommentsOutboxMessage {
  if (!value || typeof value !== "object") return false
  const type: unknown = Reflect.get(value, "type")
  const account: unknown = Reflect.get(value, "account")
  if (typeof account !== "string") return false
  if (type === "change") return true
  return type === "sent" && typeof Reflect.get(value, "requestId") === "string" && Boolean(Reflect.get(value, "thread"))
}

// Entries are plain data: JSON fields and Blobs. A copy keeps the caller's objects, which may be reactive proxies, out of the store.
function copyEntry(entry: CommentsOutboxEntry): CommentsOutboxEntry {
  // SAFETY: `JSON.parse` returns what `JSON.stringify` wrote, which has the shape of `input`.
  const input: CommentsOutboxEntry["input"] = JSON.parse(JSON.stringify(entry.input))
  // SAFETY: the copy of `input` keeps the kind of the entry.
  return { ...entry, input, files: [...entry.files], ...(entry.error ? { error: { ...entry.error } } : {}) } as CommentsOutboxEntry
}

function sortEntries(entries: CommentsOutboxEntry[]): CommentsOutboxEntry[] {
  return entries.sort((a, b) => a.order - b.order || (a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0))
}

/** An outbox store in memory. Entries live as long as the store object. Pass one store to two clients to test a reload. */
export function createMemoryOutboxStore(): CommentsOutboxStore {
  const entries = new Map<string, CommentsOutboxEntry>()
  return {
    persisted: false,
    async list(account) {
      return sortEntries([...entries.values()].filter(entry => entry.account === account).map(copyEntry))
    },
    async get(requestId) {
      const entry = entries.get(requestId)
      return entry && copyEntry(entry)
    },
    async put(entry) {
      entries.set(entry.requestId, copyEntry(entry))
    },
    async delete(requestIds) {
      for (const id of requestIds) entries.delete(id)
    },
  }
}

const databaseName = "vitehub-comments"
const format = 1

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

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, format)
    request.onupgradeneeded = () => {
      request.result.createObjectStore("outbox", { keyPath: "requestId" }).createIndex("account", "account")
    }
    request.onsuccess = () => {
      const database = request.result
      // A newer format in another tab must not wait for this tab to close.
      database.onversionchange = () => database.close()
      resolve(database)
    }
    request.onerror = () => reject(request.error ?? new Error("IndexedDB did not open."))
    request.onblocked = () => reject(new Error("IndexedDB is blocked by another tab."))
  })
}

/**
 * The default store: the `outbox` object store of the `vitehub-comments` IndexedDB database. When IndexedDB is missing or
 * does not open, as in some private windows, it keeps the entries in memory and `persisted` is `false`.
 */
export function createIndexedDBOutboxStore(): CommentsOutboxStore {
  let backend: Promise<{ database: IDBDatabase } | { memory: CommentsOutboxStore }> | undefined
  let persisted = typeof indexedDB !== "undefined"
  const open = () => backend ??= (persisted ? openDatabase() : Promise.reject(new Error("No IndexedDB.")))
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
      const transaction = database.transaction("outbox", "readonly")
      const entries = await requested<CommentsOutboxEntry[]>(transaction.objectStore("outbox").index("account").getAll(account))
      return sortEntries(entries)
    }),
    get: requestId => run(store => store.get(requestId), async (database) => {
      const transaction = database.transaction("outbox", "readonly")
      return await requested<CommentsOutboxEntry | undefined>(transaction.objectStore("outbox").get(requestId))
    }),
    put: entry => run(store => store.put(entry), async (database) => {
      const transaction = database.transaction("outbox", "readwrite")
      transaction.objectStore("outbox").put(copyEntry(entry))
      await done(transaction)
    }),
    delete: requestIds => run(store => store.delete(requestIds), async (database) => {
      const transaction = database.transaction("outbox", "readwrite")
      for (const id of requestIds) transaction.objectStore("outbox").delete(id)
      await done(transaction)
    }),
  }
}

/** The error of a try, as plain data that the store keeps. */
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

/** `wait`: try again later. `hold`: wait for a sign-in. `fail`: the server refused this entry. */
function outcomeOf(status: number): "wait" | "hold" | "fail" {
  if (status === 401) return "hold"
  if (status === 408 || status === 429) return "wait"
  return status >= 400 && status < 500 ? "fail" : "wait"
}

/** The outbox of one client. */
export function createOutbox(options: CommentsOutboxOptions, host: CommentsOutboxHost): CommentsOutboxEngine {
  const { account } = options
  const store = options.store ?? createIndexedDBOutboxStore()
  const environment = options.environment ?? createBrowserEnvironment({ channel, isMessage: isOutboxMessage })
  const lockName = `vitehub-comments-outbox:${account}`
  let entries: CommentsOutboxEntry[] = []
  // The server id of each comment that went out, by its `requestId`, for the replies that name the local id.
  const sent = new Map<string, string>()
  // The id that the server gives each waiting reply, by thread and `requestId`. A hash, so it is ready after a tick.
  const replyIds = new Map<string, string>()
  const replyId = (threadId: string, requestId: string): string | undefined => {
    const key = JSON.stringify([threadId, requestId])
    if (!replyIds.has(key)) {
      replyIds.set(key, "")
      void replyMessageId(threadId, requestId).then((id) => {
        replyIds.set(key, id)
        host.changed()
      })
    }
    return replyIds.get(key) || undefined
  }
  let loading: Promise<void> = Promise.resolve()
  // The run of `kick` that leads or waits for the lock. Its `giveUp` stops it.
  let leading: { giveUp: () => void } | undefined
  let again = false
  let cancelWait: (() => void) | undefined
  let attempt = 0
  // A 401 holds the queue until `retry()` or a new page.
  let held = false

  const post = (message: CommentsOutboxMessage): void => environment.post(message)
  // Loads run one after another, so after `await reload()` the entries hold every write made before it.
  const reload = (): Promise<void> => loading = loading.catch(() => undefined).then(async () => {
    entries = await store.list(account)
    host.changed()
  })
  const changed = async (): Promise<void> => {
    await reload()
    post({ type: "change", account })
  }

  const serverThread = (id: string): CommentThread | undefined => {
    for (const thread of host.threads()) if (thread.id === id) return thread
    return undefined
  }
  /** The server id of a thread that the client may still name by its local id. */
  const realId = (threadId: string): string => {
    const known = sent.get(threadId)
    if (known) return known
    for (const thread of host.threads()) if (thread.requestId === threadId) return thread.id
    return threadId
  }

  const delivery = (entry: CommentsOutboxEntry): CommentDelivery => ({
    status: entry.status === "failed" ? "failed" : "pending",
    requestId: entry.requestId,
    files: entry.files,
    ...(entry.error ? { error: entry.error } : {}),
  })
  const author = (): CommentUser => host.user ?? { id: account }
  const localMessage = (entry: CommentsOutboxEntry, threadId: string): CommentMessage => ({
    id: entry.requestId,
    threadId,
    body: entry.input.body,
    author: author(),
    mentions: entry.input.mentions ?? [],
    attachments: entry.input.attachments ?? [],
    createdAt: entry.createdAt,
    delivery: delivery(entry),
  })

  const overlay = (threads: readonly CommentThread[]) => {
    const onServer = new Set<string>()
    for (const thread of threads) if (thread.requestId) onServer.add(thread.requestId)
    const replies = new Map<string, CommentsOutboxEntry[]>()
    for (const entry of entries) {
      if (entry.kind !== "reply") continue
      const id = realId(entry.input.threadId)
      replies.set(id, [...(replies.get(id) ?? []), entry])
    }
    const withReplies = (thread: CommentThread): CommentThread => {
      const waiting = replies.get(thread.id)
      if (!waiting) return thread
      // A reply that the server has, whose answer was lost, shows once.
      const have = new Set(thread.messages.map(message => message.id))
      const added = waiting.filter((entry) => {
        const id = thread.delivery ? undefined : replyId(thread.id, entry.requestId)
        return !(id && have.has(id))
      }).map(entry => localMessage(entry, thread.id))
      return added.length ? { ...thread, messages: [...thread.messages, ...added] } : thread
    }
    const server = threads.map(withReplies)
    const local: CommentThread[] = []
    for (const entry of entries) {
      if (entry.kind !== "create" || onServer.has(entry.requestId) || sent.has(entry.requestId)) continue
      local.push(withReplies(localThread(entry)))
    }
    return { server, local }
  }
  const localThread = (entry: CommentsOutboxEntry & { kind: "create" }): CommentThread => {
    const { input } = entry
    return {
      id: entry.requestId,
      scope: "",
      n: 0,
      subject: input.subject,
      anchor: input.anchor,
      status: "open",
      author: author(),
      messages: [localMessage(entry, entry.requestId)],
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      ...(input.revision === undefined ? {} : { revision: input.revision }),
      createdAt: entry.createdAt,
      updatedAt: entry.createdAt,
      requestId: entry.requestId,
      delivery: delivery(entry),
    }
  }

  /** The first entry that may go out now. A reply waits while its comment has not gone out. */
  const next = (list: readonly CommentsOutboxEntry[]): CommentsOutboxEntry | undefined => {
    const waiting = new Set(list.flatMap(entry => entry.kind === "create" ? [entry.requestId] : []))
    return list.find(entry => entry.status !== "failed" && !(entry.kind === "reply" && waiting.has(entry.input.threadId)))
  }

  const wait = (ms: number): void => {
    cancelWait?.()
    cancelWait = environment.schedule(() => {
      cancelWait = undefined
      kick()
    }, ms)
  }

  /** Sends one entry. `true` when the next one may go now. */
  const send = async (entry: CommentsOutboxEntry): Promise<boolean> => {
    await store.put({ ...entry, status: "sending" })
    let thread: CommentThread
    try {
      if (entry.kind === "create") {
        thread = await host.transport.create({ ...entry.input, requestId: entry.requestId, files: entry.files })
      }
      else {
        const threadId = realId(entry.input.threadId)
        const subject: CommentSubject | undefined = serverThread(threadId)?.subject
        thread = await host.transport.reply({ ...entry.input, threadId, requestId: entry.requestId, files: entry.files, ...(subject ? { subject } : {}) })
      }
    }
    catch (cause) {
      const { retryAfter, ...error } = deliveryError(cause)
      const outcome = outcomeOf(error.status)
      // A dismiss or a clear while it was on its way removed it. Nothing to keep.
      if (await store.get(entry.requestId)) await store.put({ ...entry, status: outcome === "fail" ? "failed" : "pending", error })
      await changed()
      if (outcome === "fail") return true
      if (outcome === "hold") held = true
      else wait(retryAfter ?? backoffDelay(attempt++, environment.random()))
      return false
    }
    attempt = 0
    // The server copy goes in before the entry leaves, so the client always shows one of them.
    host.upsert(thread)
    if (entry.kind === "create") {
      sent.set(entry.requestId, thread.id)
      // Replies to the comment wait in the store with its local id. They get the server id before they go.
      for (const reply of await store.list(account)) {
        if (reply.kind === "reply" && reply.input.threadId === entry.requestId) await store.put({ ...reply, input: { ...reply.input, threadId: thread.id } })
      }
    }
    await store.delete([entry.requestId])
    await reload()
    post({ type: "sent", account, requestId: entry.requestId, thread })
    return true
  }

  const drain = async (signal: AbortSignal): Promise<void> => {
    while (!signal.aborted && !held && !cancelWait && environment.isOnline()) {
      const list = await store.list(account)
      const entry = next(list)
      if (!entry) return
      if (!await send(entry)) return
    }
  }

  /** Sends what waits, in the tab that holds the lock. */
  function kick(): void {
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

  const enqueue = async (entry: CommentsOutboxEntry): Promise<void> => {
    await store.put(entry)
    await changed()
  }
  const fields = (requestId: string | undefined, files: Blob[] | undefined) => {
    const now = Date.now()
    return {
      requestId: requestId ?? randomUUID(),
      account,
      files: [...(files ?? [])],
      createdAt: now,
      order: Math.max(now, (entries.at(-1)?.order ?? 0) + 1),
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
    owns: (threadId, messageId) => entries.some(entry => entry.requestId === (messageId ?? threadId)),
    async create({ files, requestId, ...input }) {
      const entry = { ...fields(requestId, files), kind: "create" as const, input }
      await enqueue(entry)
      kick()
      // A tab that sends already may have sent it by now. The caller still gets the comment as it was saved.
      return localThread(entry)
    },
    async reply({ files, requestId, subject: _subject, ...input }) {
      const threadId = realId(input.threadId)
      const shown = () => serverThread(threadId)
      if (!shown() && !entries.some(entry => entry.kind === "create" && entry.requestId === threadId)) return null
      await enqueue({ ...fields(requestId, files), kind: "reply", input: { ...input, threadId } })
      kick()
      // The comment shows as its waiting entry until the server copy is in the client, so one of them is here.
      const thread = serverThread(realId(threadId))
      // SAFETY: the waiting comment leaves `entries` only after its server copy is in the client.
      return thread ? overlay([thread]).server[0]! : overlay([]).local.find(local => local.id === threadId)!
    },
    async retry(requestId) {
      held = false
      attempt = 0
      cancelWait?.()
      cancelWait = undefined
      if (requestId !== undefined) {
        const entry = await store.get(requestId)
        if (entry?.account === account && entry.status === "failed") {
          const { error: _error, ...rest } = entry
          await store.put({ ...rest, status: "pending" })
          await changed()
        }
      }
      kick()
    },
    async dismiss(requestId) {
      const entry = await store.get(requestId)
      if (!entry || entry.account !== account || entry.status === "sending") return false
      const replies = entry.kind === "create" ? (await store.list(account)).filter(other => other.kind === "reply" && other.input.threadId === requestId).map(other => other.requestId) : []
      await store.delete([requestId, ...replies])
      await changed()
      return true
    },
    async edit(requestId, body, mentions) {
      const entry = await store.get(requestId)
      if (!entry || entry.account !== account || entry.status === "sending") return false
      const { error: _error, ...rest } = entry
      // SAFETY: only `body` and `mentions` change, which both kinds have.
      const edited = { ...rest, input: { ...rest.input, body, ...(mentions ? { mentions } : {}) }, status: "pending" } as CommentsOutboxEntry
      await store.put(edited)
      await changed()
      if (entry.status === "failed") kick()
      return true
    },
    async clear() {
      held = false
      cancelWait?.()
      cancelWait = undefined
      await store.delete((await store.list(account)).map(entry => entry.requestId))
      await changed()
    },
    start() {
      const stops = [
        environment.listen((event) => {
          if (event !== "online" && event !== "visible") return
          cancelWait?.()
          cancelWait = undefined
          kick()
        }),
        environment.receive((message) => {
          if (message.account !== account) return
          if (message.type === "sent") {
            sent.set(message.requestId, message.thread.id)
            host.upsert(message.thread)
          }
          void reload()
        }),
      ]
      void reload()
      kick()
      return () => {
        for (const stop of stops.splice(0)) stop()
        cancelWait?.()
        cancelWait = undefined
        leading?.giveUp()
        leading = undefined
      }
    },
  }
}
