import { afterEach, describe, expect, it, vi } from "vitest"

import { createCommentsClient, createMemoryOutboxStore, type CommentCreateInput, type CommentFiles, type CommentReplyInput, type CommentsOutboxEnvironment, type CommentsOutboxMessage, type CommentsOutboxStore, type CommentUser } from "../src/client.ts"
import { createMemoryTransport, type MemoryTransport } from "../src/testing.ts"

const ana: CommentUser = { id: "ana", name: "Ana Ruiz" }
const subject = { kind: "page", id: "/pricing" }
const anchor = { kind: "element", selector: "#cta", x: 500, y: 500 } as const

/** One browser: tabs that share one lock and one channel, one network switch, and timers that run when the test says. */
function createBrowser() {
  const listeners = new Set<(event: "online" | "offline" | "visible" | "hidden") => void>()
  const channels = new Set<(message: CommentsOutboxMessage) => void>()
  const timers: Array<{ ms: number, task: () => void, cancelled: boolean }> = []
  let lock: Promise<void> = Promise.resolve()
  let online = true
  return {
    timers,
    get waits() {
      return timers.filter(timer => !timer.cancelled).map(timer => timer.ms)
    },
    set online(value: boolean) {
      online = value
      for (const listener of listeners) listener(value ? "online" : "offline")
    },
    /** Runs every timer that is due. */
    runTimers() {
      for (const timer of timers.splice(0)) if (!timer.cancelled) timer.task()
    },
    tab(): CommentsOutboxEnvironment {
      const own = new Set<(message: CommentsOutboxMessage) => void>()
      return {
        listen(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        isVisible: () => true,
        isOnline: () => online,
        lock: (_name, task) => task(),
        // One lock for the whole browser, granted in request order, as Web Locks do.
        lead(_name, task) {
          const controller = new AbortController()
          const previous = lock
          let release!: () => void
          lock = new Promise(resolve => release = resolve)
          void previous.then(() => controller.signal.aborted ? undefined : task(controller.signal)).finally(release)
          return () => controller.abort()
        },
        post(message) {
          const copy: CommentsOutboxMessage = JSON.parse(JSON.stringify(message))
          for (const listener of channels) if (!own.has(listener)) listener(copy)
        },
        receive(listener) {
          channels.add(listener)
          own.add(listener)
          return () => {
            channels.delete(listener)
            own.delete(listener)
          }
        },
        schedule(task, ms) {
          const timer = { ms, task, cancelled: false }
          timers.push(timer)
          return () => {
            timer.cancelled = true
          }
        },
        random: () => 0,
      }
    },
  }
}

type Failure = Error & { status?: number, retryAfter?: number }
const failure = (status: number, retryAfter?: number): Failure => Object.assign(new Error(`Status ${status}`), { status, ...(retryAfter === undefined ? {} : { retryAfter }) })

/** A memory transport whose next calls fail as the test says. `lost` stores the comment and then loses the answer. */
function createServer() {
  const memory = createMemoryTransport({ user: ana, users: [ana] })
  const plan: Array<Failure | "lost" | Promise<void>> = []
  const creates: Array<CommentCreateInput & CommentFiles> = []
  const replies: Array<CommentReplyInput & CommentFiles> = []
  const next = async <T>(run: () => Promise<T>): Promise<T> => {
    const step = plan.shift()
    if (step instanceof Promise) await step
    else if (step === "lost") {
      await run()
      throw failure(0)
    }
    else if (step) throw step
    return run()
  }
  const transport: MemoryTransport = {
    ...memory,
    create: (input) => {
      creates.push(input)
      return next(() => memory.create(input))
    },
    reply: (input) => {
      replies.push(input)
      return next(() => memory.reply(input))
    },
  }
  return { memory, transport, plan, creates, replies }
}

function setup(options: { store?: CommentsOutboxStore, browser?: ReturnType<typeof createBrowser>, server?: ReturnType<typeof createServer>, account?: string } = {}) {
  const browser = options.browser ?? createBrowser()
  const server = options.server ?? createServer()
  const store = options.store ?? createMemoryOutboxStore()
  const client = createCommentsClient({ transport: server.transport, user: ana, query: { page: "/pricing" }, outbox: { account: options.account ?? ana.id, store, environment: browser.tab() } })
  const stop = client.start()
  stops.push(stop)
  return { browser, server, store, client, stop }
}

const stops: Array<() => void> = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
})

describe("the comments outbox", () => {
  it("shows a comment at once, and the server copy replaces it by its requestId", async () => {
    const { browser, server, client } = setup()
    browser.online = false
    const thread = await client.create({ subject, anchor, body: "The price is wrong" })
    expect(thread).toMatchObject({ id: thread.requestId, n: 0, delivery: { status: "pending" }, messages: [{ body: "The price is wrong", delivery: { status: "pending" } }] })
    expect(client.threads.map(item => item.id)).toEqual([thread.id])
    expect(server.creates).toHaveLength(0)

    browser.online = true
    await vi.waitFor(() => expect(client.outbox.entries).toHaveLength(0))
    expect(server.creates[0]).toMatchObject({ requestId: thread.requestId, files: [] })
    expect(client.threads).toHaveLength(1)
    expect(client.threads[0]).toMatchObject({ n: 1, requestId: thread.requestId })
    expect(client.threads[0]!.delivery).toBeUndefined()
  })

  it("sends a comment once when the answer was lost, and shows it once meanwhile", async () => {
    const { browser, server, client } = setup()
    await vi.waitFor(() => expect(client.status).toBe("ready"))
    server.plan.push("lost")
    await client.create({ subject, anchor, body: "Typo in the title" })
    await vi.waitFor(() => expect(browser.waits).toHaveLength(1))
    expect(client.outbox.queued[0]).toMatchObject({ status: "pending", error: { status: 0 } })

    // The server has it. A refresh lists it while the outbox still waits to resend.
    await client.refresh()
    expect(server.memory.threads).toHaveLength(1)
    expect(client.threads).toHaveLength(1)
    expect(client.threads[0]!.delivery).toBeUndefined()

    browser.runTimers()
    await vi.waitFor(() => expect(client.outbox.entries).toHaveLength(0))
    expect(server.creates).toHaveLength(2)
    expect(server.memory.threads).toHaveLength(1)
    expect(client.threads).toHaveLength(1)
  })

  it("sends from one tab when two tabs share the lock", async () => {
    const browser = createBrowser()
    const server = createServer()
    const store = createMemoryOutboxStore()
    const first = setup({ browser, server, store })
    const second = setup({ browser, server, store })
    browser.online = false
    await first.client.create({ subject, anchor, body: "From the first tab" })
    await vi.waitFor(() => expect(second.client.outbox.entries).toHaveLength(1))
    expect(second.client.threads[0]).toMatchObject({ delivery: { status: "pending" } })

    browser.online = true
    await Promise.all([first.client.outbox.retry(), second.client.outbox.retry()])
    await vi.waitFor(() => expect(first.client.outbox.entries).toHaveLength(0))
    await vi.waitFor(() => expect(second.client.outbox.entries).toHaveLength(0))
    expect(server.creates).toHaveLength(1)
    // The tab that did not send hears the server copy.
    expect(second.client.threads).toHaveLength(1)
    expect(second.client.threads[0]).toMatchObject({ n: 1 })
    expect(second.client.threads[0]!.delivery).toBeUndefined()
  })

  it("resumes the saved queue with its files in a new client", async () => {
    const store = createMemoryOutboxStore()
    const server = createServer()
    const before = setup({ store, server })
    before.browser.online = false
    const shot = new Blob(["png bytes"], { type: "image/png" })
    const thread = await before.client.create({ subject, anchor, body: "See the picture", files: [shot] })
    expect(thread.messages[0]!.delivery!.files).toHaveLength(1)
    before.stop()

    // A reload: a new page with the same store.
    const after = setup({ store, server })
    await vi.waitFor(() => expect(server.memory.threads).toHaveLength(1))
    await vi.waitFor(() => expect(after.client.outbox.entries).toHaveLength(0))
    expect(server.creates).toHaveLength(1)
    const [sent] = server.creates[0]!.files!
    expect(await sent!.text()).toBe("png bytes")
    expect(server.memory.threads[0]!.messages[0]!.attachments).toHaveLength(1)
  })

  it("holds the replies of a refused comment, and sends them to its server id after a retry", async () => {
    const { browser, server, client } = setup()
    browser.online = false
    const thread = await client.create({ subject, anchor, body: "Wrong price" })
    const replied = await client.reply({ threadId: thread.id, body: "On the yearly plan too" })
    expect(replied.messages.map(message => message.body)).toEqual(["Wrong price", "On the yearly plan too"])

    server.plan.push(failure(403))
    browser.online = true
    await vi.waitFor(() => expect(client.outbox.failures).toHaveLength(1))
    expect(client.outbox.failures[0]).toMatchObject({ requestId: thread.id, error: { status: 403 } })
    expect(client.threads[0]).toMatchObject({ delivery: { status: "failed" } })
    expect(server.replies).toHaveLength(0)

    await client.outbox.retry(thread.id)
    await vi.waitFor(() => expect(client.outbox.entries).toHaveLength(0))
    const [stored] = server.memory.threads
    expect(server.replies[0]).toMatchObject({ threadId: stored!.id })
    expect(stored!.messages.map(message => message.body)).toEqual(["Wrong price", "On the yearly plan too"])
    expect(client.threads).toHaveLength(1)
    expect(client.threads[0]!.messages).toHaveLength(2)
  })

  it("waits for Retry-After on 429, and for a retry on 401", async () => {
    const { browser, server, client } = setup()
    server.plan.push(failure(429, 7000))
    await client.create({ subject, anchor, body: "Slow down" })
    await vi.waitFor(() => expect(browser.waits).toEqual([7000]))
    expect(client.outbox.queued[0]).toMatchObject({ status: "pending", error: { status: 429 } })
    browser.runTimers()
    await vi.waitFor(() => expect(client.outbox.entries).toHaveLength(0))

    server.plan.push(failure(401))
    await client.create({ subject, anchor, body: "Signed out" })
    await vi.waitFor(() => expect(client.outbox.queued[0]?.error?.status).toBe(401))
    expect(browser.waits).toEqual([])
    browser.online = false
    browser.online = true
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(server.creates).toHaveLength(3)
    expect(client.outbox.queued).toHaveLength(1)

    await client.outbox.retry()
    await vi.waitFor(() => expect(client.outbox.entries).toHaveLength(0))
    expect(server.creates).toHaveLength(4)
  })

  it("backs off from 1 s on a server error", async () => {
    const { browser, server, client } = setup()
    server.plan.push(failure(503), failure(503))
    await client.create({ subject, anchor, body: "Down" })
    await vi.waitFor(() => expect(browser.waits).toEqual([500]))
    browser.runTimers()
    await vi.waitFor(() => expect(browser.waits).toEqual([1000]))
    browser.runTimers()
    await vi.waitFor(() => expect(client.outbox.entries).toHaveLength(0))
  })

  it("edits a comment before it sends, and refuses while it is on its way", async () => {
    const { browser, server, client } = setup()
    browser.online = false
    const thread = await client.create({ subject, anchor, body: "Frist" })
    const edited = await client.edit({ threadId: thread.id, messageId: thread.id, body: "First" })
    expect(edited.messages[0]!.body).toBe("First")

    let answer!: () => void
    server.plan.push(new Promise<void>(resolve => answer = resolve))
    browser.online = true
    await vi.waitFor(() => expect(server.creates).toHaveLength(1))
    expect(server.creates[0]!.body).toBe("First")
    await expect(client.edit({ threadId: thread.id, messageId: thread.id, body: "Late" })).rejects.toMatchObject({ code: "COMMENTS_OUTBOX_SENDING" })
    answer()
    await vi.waitFor(() => expect(client.outbox.entries).toHaveLength(0))
    expect(server.memory.threads[0]!.messages[0]!.body).toBe("First")
  })

  it("dismisses a comment and its replies, and sends nothing", async () => {
    const { browser, server, client } = setup()
    browser.online = false
    const thread = await client.create({ subject, anchor, body: "Never mind" })
    await client.reply({ threadId: thread.id, body: "Really" })
    expect(await client.delete({ threadId: thread.id })).toBeNull()
    expect(client.outbox.entries).toEqual([])
    expect(client.threads).toEqual([])
    browser.online = true
    await client.outbox.retry()
    expect(server.creates).toHaveLength(0)
    expect(server.replies).toHaveLength(0)
  })

  it("sends only the entries of its own account", async () => {
    const store = createMemoryOutboxStore()
    const server = createServer()
    const ben = setup({ store, server, account: "ben" })
    ben.browser.online = false
    await ben.client.create({ subject, anchor, body: "From Ben" })
    ben.stop()
    const other = setup({ store, server })
    await other.client.outbox.retry()
    await vi.waitFor(() => expect(other.client.status).toBe("ready"))
    expect(other.client.outbox.entries).toEqual([])
    expect(other.client.threads).toEqual([])
    expect(server.creates).toHaveLength(0)
    expect(await store.list("ben")).toHaveLength(1)
  })

  it("clears every entry of the account", async () => {
    const { browser, client } = setup()
    browser.online = false
    await client.create({ subject, anchor, body: "One" })
    await client.create({ subject, anchor, body: "Two" })
    expect(client.outbox.queued).toHaveLength(2)
    await client.outbox.clear()
    expect(client.outbox.entries).toEqual([])
    expect(client.threads).toEqual([])
  })
})
