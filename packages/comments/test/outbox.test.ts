import { afterEach, describe, expect, it, vi } from "vitest"

import { createCommentsClient, createMemoryOutboxStore, type CommentCreateInput, type CommentFiles, type CommentReplyInput, type CommentsOutboxEnvironment, type CommentsOutboxMessage, type CommentsOutboxStore, type CommentUser } from "../src/client.ts"
import { createMemoryTransport, type MemoryTransport } from "../src/testing.ts"

const ana: CommentUser = { id: "ana", name: "Ana Ruiz" }
const subject = { kind: "page", id: "/pricing" }
const anchor = { kind: "element", selector: "#cta", x: 500, y: 500 } as const

/** One browser: tabs that share one lock and one channel, one network switch, and timers that run when the test says. */
function createBrowser() {
  let now = Date.now()
  vi.spyOn(Date, "now").mockImplementation(() => now)
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
      const ready = timers.splice(0).filter(timer => !timer.cancelled)
      now += Math.max(0, ...ready.map(timer => timer.ms))
      for (const timer of ready) timer.task()
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
  vi.restoreAllMocks()
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
    const draft = await client.create({ subject, anchor, body: "Typo in the title" })
    await vi.waitFor(() => expect(browser.waits).toHaveLength(1))
    expect(client.outbox.queued[0]).toMatchObject({ status: "pending", error: { status: 0 } })
    await expect(client.edit({ threadId: draft.id, messageId: draft.id, body: "Corrected" })).rejects.toMatchObject({ code: "COMMENTS_OUTBOX_SENDING" })
    await expect(client.outbox.dismiss(draft.id)).resolves.toBe(false)

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

  it("isolates reused keys and returns the first result for a replay", async () => {
    const browser = createBrowser()
    browser.online = false
    const first = setup({ browser })
    const other = setup({ browser, store: first.store, account: "ben" })
    const input = { subject, anchor, body: "First draft", requestId: "same-key" }
    const draft = await first.client.create(input)
    expect(await first.client.create({ ...input, body: "Do not replace the draft" })).toEqual(draft)
    await other.client.create({ ...input, body: "Other account" })
    expect((await first.store.list(ana.id))[0]?.input.body).toBe("First draft")
    expect((await first.store.list("ben"))[0]?.input.body).toBe("Other account")
    other.stop()
    browser.online = true
    await vi.waitFor(() => expect(first.client.outbox.entries).toHaveLength(0))
    expect(await first.client.create(input)).toEqual(first.server.memory.threads[0])
    expect(first.server.creates).toHaveLength(1)
  })

  it("queues a reply to a thread opened by id and persists its subject", async () => {
    const { browser, server, client, store, stop } = setup()
    const target = { kind: "page", id: "/not-in-the-list" }
    const thread = await server.memory.create({ subject: target, anchor, body: "Outside the list" })
    await client.get({ id: thread.id })
    browser.online = false
    const reply = await client.reply({ threadId: thread.id, body: "Offline reply", files: [new Blob(["file"])] })
    expect(reply.messages.at(-1)?.delivery?.status).toBe("pending")
    expect(server.replies).toHaveLength(0)
    expect((await store.list(ana.id))[0]).toMatchObject({ kind: "reply", subject: target })
    stop()
    const reloaded = setup({ browser, server, store })
    browser.online = true
    await vi.waitFor(() => expect(server.replies[0]).toMatchObject({ threadId: thread.id, subject: target }))
    await vi.waitFor(() => expect(reloaded.client.outbox.entries).toHaveLength(0))
  })

  it("keeps completed uploads across reload and a lost write response", async () => {
    const browser = createBrowser()
    const server = createServer()
    const store = createMemoryOutboxStore()
    const send = server.transport.create
    let uploads = 0
    server.transport.create = async ({ files, outbox, ...input }) => {
      const attachments = [...(input.attachments ?? [])]
      for (const _file of files ?? []) {
        const key = `files/${++uploads}.png`
        await outbox?.uploaded(key)
        attachments.push(key)
      }
      return send({ ...input, attachments })
    }
    server.plan.push(failure(429, 7000), "lost")
    const first = setup({ browser, server, store })
    await first.client.create({ subject, anchor, body: "Screenshot", files: [new Blob(["pixels"])] })
    await vi.waitFor(() => expect(first.client.outbox.entries[0]?.error?.status).toBe(429))
    expect(uploads).toBe(1)
    first.stop()

    const second = setup({ browser, server, store })
    await second.client.outbox.retry()
    await vi.waitFor(() => expect(second.client.outbox.entries[0]?.error?.status).toBe(0))
    await second.client.outbox.retry()
    await vi.waitFor(() => expect(second.client.outbox.entries).toHaveLength(0))
    expect(uploads).toBe(1)
    expect(server.creates).toHaveLength(3)
    expect(server.memory.threads).toHaveLength(1)
    expect(server.memory.threads[0]?.messages[0]?.attachments).toEqual(["files/1.png"])
  })

  it("shares the auth hold and delay across tab handoffs", async () => {
    const first = setup()
    const second = setup(first)
    first.server.plan.push(failure(429, 7000), failure(401))
    await first.client.create({ subject, anchor, body: "Queued" })
    await vi.waitFor(() => expect(second.client.outbox.entries[0]?.error?.status).toBe(429))
    expect(first.server.creates).toHaveLength(1)
    first.stop()
    first.browser.runTimers()
    await vi.waitFor(() => expect(second.client.outbox.entries[0]?.error?.status).toBe(401))
    const reloaded = setup(first)
    await vi.waitFor(() => expect(reloaded.client.outbox.entries[0]?.error?.status).toBe(401))
    expect(first.server.creates).toHaveLength(2)
    await reloaded.client.outbox.retry()
    await vi.waitFor(() => expect(second.client.outbox.entries).toHaveLength(0))
    expect(first.server.creates).toHaveLength(3)
  })

  it("does not restore an entry cleared while a send is pending", async () => {
    const { server, client, store } = setup()
    let refuse!: (reason: Error) => void
    server.plan.push(new Promise<void>((_, reject) => refuse = reject))
    await client.create({ subject, anchor, body: "Discard on sign-out" })
    await vi.waitFor(() => expect(server.creates).toHaveLength(1))
    await client.outbox.clear()
    refuse(failure(503))
    await client.outbox.retry()
    expect(await store.list(ana.id)).toEqual([])
    expect(client.threads).toEqual([])
  })

  it("shows a reply once when its answer was lost, and the resend adds no second message", async () => {
    const { browser, server, client, store, stop } = setup()
    const thread = await client.create({ subject, anchor, body: "Wrong price" })
    await vi.waitFor(() => expect(client.outbox.entries).toHaveLength(0))
    const stored = client.threads[0]!
    server.plan.push("lost")
    await client.reply({ threadId: stored.id, body: "Yearly too" })
    await vi.waitFor(() => expect(browser.waits).toHaveLength(1))

    browser.online = false
    stop()
    const reloaded = createCommentsClient({ transport: server.transport, user: ana, query: { page: "/pricing" }, outbox: { account: ana.id, store, environment: browser.tab() } })
    const publications: number[] = []
    stops.push(reloaded.onChange(() => {
      const messages = reloaded.threads[0]?.messages
      if (messages) publications.push(messages.length)
    }), reloaded.start())
    await vi.waitFor(() => expect(reloaded.outbox.entries).toHaveLength(1))
    const refreshed = await reloaded.refresh()
    expect(refreshed[0]!.messages.map(message => message.body)).toEqual(["Wrong price", "Yearly too"])
    expect(refreshed[0]!.messages[1]!.delivery).toBeUndefined()
    expect(publications).not.toContain(3)

    browser.online = true
    await vi.waitFor(() => expect(reloaded.outbox.entries).toHaveLength(0))
    expect(server.replies).toHaveLength(2)
    expect(server.memory.threads[0]!.messages).toHaveLength(2)
    expect(reloaded.threads[0]!.messages).toHaveLength(2)
    expect(thread.id).not.toBe(stored.id)
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

  it("holds the queue on 402, as on 401, until a retry", async () => {
    const { browser, server, client } = setup()
    server.plan.push(failure(402))
    await client.create({ subject, anchor, body: "Over the plan" })
    await vi.waitFor(() => expect(client.outbox.queued[0]?.error?.status).toBe(402))
    expect(client.outbox.failures).toEqual([])
    expect(browser.waits).toEqual([])
    browser.online = false
    browser.online = true
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(server.creates).toHaveLength(1)

    await client.outbox.retry()
    await vi.waitFor(() => expect(client.outbox.entries).toHaveLength(0))
    expect(server.creates).toHaveLength(2)
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

  it("lets the reader edit or dismiss a comment refused after a try that got no answer", async () => {
    const { browser, server, client } = setup()
    await vi.waitFor(() => expect(client.status).toBe("ready"))
    server.plan.push(failure(0), failure(413))
    const draft = await client.create({ subject, anchor, body: "Too long" })
    await vi.waitFor(() => expect(browser.waits).toHaveLength(1))
    await expect(client.outbox.dismiss(draft.id)).resolves.toBe(false)

    browser.runTimers()
    await vi.waitFor(() => expect(client.outbox.failures).toHaveLength(1))
    await expect(client.outbox.edit(draft.id, "Short")).resolves.toBe(true)
    await vi.waitFor(() => expect(client.outbox.entries).toHaveLength(0))
    expect(server.memory.threads.map(thread => thread.messages[0]!.body)).toEqual(["Short"])

    server.plan.push(failure(0), failure(404))
    const gone = await client.create({ subject, anchor, body: "Drop deleted" })
    await vi.waitFor(() => expect(browser.waits).toHaveLength(1))
    browser.runTimers()
    await vi.waitFor(() => expect(client.outbox.failures).toHaveLength(1))
    await expect(client.outbox.dismiss(gone.id)).resolves.toBe(true)
    expect(client.outbox.entries).toEqual([])
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
