import { H3 } from "h3"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createCommentsClient, createMemoryOutboxStore, createRestTransport, type CommentCreateInput, type CommentFiles, type CommentReplyInput, type CommentsOutboxEnvironment, type CommentsOutboxMessage, type CommentsOutboxStore, type CommentsTransport, type CommentUser } from "../src/client.ts"
import { createCommentsHandler } from "../src/runtime/handler.ts"
import { createMemoryTransport, type MemoryTransport } from "../src/testing.ts"
import { createComments } from "./harness.ts"

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

function setup(options: { store?: CommentsOutboxStore, browser?: ReturnType<typeof createBrowser>, server?: ReturnType<typeof createServer>, account?: string, transport?: CommentsTransport } = {}) {
  const browser = options.browser ?? createBrowser()
  const server = options.server ?? createServer()
  const store = options.store ?? createMemoryOutboxStore()
  const client = createCommentsClient({ transport: options.transport ?? server.transport, user: ana, query: { page: "/pricing" }, outbox: { account: options.account ?? ana.id, store, environment: browser.tab() } })
  const stop = client.start()
  stops.push(stop)
  return { browser, server, store, client, stop }
}

function createSlowStore() {
  const memory = createMemoryOutboxStore()
  const plan: Array<Promise<void> | Error> = []
  const store: CommentsOutboxStore = {
    persisted: false,
    list: account => memory.list(account),
    async update(account, change) {
      const step = plan.shift()
      if (step instanceof Error) throw step
      if (step) await step
      return memory.update(account, change)
    },
  }
  return { store, plan }
}

function createSerialStore() {
  const memory = createMemoryOutboxStore()
  const plan: Array<Promise<void>> = []
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const result = queue.then(run)
    queue = result.catch(() => undefined)
    return result
  }
  const store: CommentsOutboxStore = {
    persisted: false,
    list: account => serial(() => memory.list(account)),
    update(account, change) {
      const step = plan.shift()
      return serial(async () => {
        await step
        return memory.update(account, change)
      })
    },
  }
  return { store, plan }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((pass, fail) => {
    resolve = pass
    reject = fail
  })
  return { promise, resolve, reject }
}

function gate() {
  const { promise, resolve: open } = deferred<void>()
  return { promise, open }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

const stops: Array<() => void> = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
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
    await client.get({ threadId: thread.id })
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

  it.each([["create", 409], ["reply", 404]] as const)("keeps a saved %s locked after a lost answer and a retry that returns %i", async (kind, status) => {
    let canRead = true
    let loseAnswer = false
    const comments = await createComments({ identify: () => ({ ...ana }), authorize: ({ action }) => action !== "read" || canRead })
    const app = new H3().all("/_vitehub/comments/**", createCommentsHandler({ comments, realtime: false }))
    const transport = createRestTransport({
      base: "http://site.test",
      async fetch(url, init) {
        const answer = await app.fetch(new Request(url, init))
        if (loseAnswer && init?.method === "POST" && answer.ok) {
          loseAnswer = false
          throw new TypeError("Lost answer")
        }
        return answer
      },
    })
    const parent = kind === "reply" ? await transport.create({ subject, anchor, body: "Parent" }) : undefined
    const { browser, client } = setup({ transport })
    await vi.waitFor(() => expect(client.status).toBe("ready"))
    loseAnswer = true
    if (parent) await client.reply({ threadId: parent.id, body: "Original" })
    else await client.create({ subject, anchor, body: "Original" })
    await vi.waitFor(() => expect(browser.waits).toHaveLength(1))
    const id = client.outbox.entries[0]!.id
    canRead = false
    browser.runTimers()
    await vi.waitFor(() => expect(client.outbox.failures[0]?.error?.status).toBe(status))
    await expect(client.outbox.edit(id, "Changed")).resolves.toBe(false)
    await expect(client.outbox.dismiss(id)).resolves.toBe(false)
    canRead = true
    await client.outbox.retry(id)
    await vi.waitFor(() => expect(client.outbox.entries).toHaveLength(0))
    expect((await transport.list({ page: "/pricing" })).map(thread => thread.messages.map(message => message.body)))
      .toEqual([parent ? ["Parent", "Original"] : ["Original"]])
  })

  it("lets the reader edit a refused comment after an attachment upload got no answer", async () => {
    let uploads = 0
    const bodies: string[] = []
    const transport = createRestTransport({
      async fetch(url, init) {
        if (init?.method !== "POST") return Response.json({ data: [] })
        if (String(url).endsWith("/attachments")) {
          if (++uploads === 1) throw new TypeError("Lost upload answer")
          return Response.json({ data: { key: "files/shot.png" } })
        }
        bodies.push(String(init.body))
        return Response.json({ error: { code: "TOO_LONG", why: "Too long" } }, { status: 413 })
      },
    })
    const { browser, client } = setup({ transport })
    await vi.waitFor(() => expect(client.status).toBe("ready"))
    const draft = await client.create({ subject, anchor, body: "Too long", files: [new Blob(["pixels"])] })
    await vi.waitFor(() => expect(browser.waits).toHaveLength(1))
    expect(bodies).toHaveLength(0)
    browser.runTimers()
    await vi.waitFor(() => expect(client.outbox.failures[0]?.error?.status).toBe(413))
    await expect(client.outbox.edit(draft.id, "Short")).resolves.toBe(true)
    await vi.waitFor(() => expect(bodies[1]).toContain('"body":"Short"'))
    expect(uploads).toBe(2)
  })

  it("lets the reader dismiss a refused reply after its thread lookup got no answer", async () => {
    const server = createServer()
    const parent = await server.memory.create({ subject: { kind: "page", id: "/other" }, anchor, body: "Parent" })
    server.transport.get = vi.fn().mockRejectedValueOnce(failure(0)).mockResolvedValue(parent)
    const { browser, client } = setup({ server })
    await vi.waitFor(() => expect(client.status).toBe("ready"))
    server.plan.push(failure(404))
    const draft = await client.reply({ threadId: parent.id, body: "Reply", files: [new Blob(["file"])] })
    const id = draft.messages.at(-1)!.id
    await vi.waitFor(() => expect(browser.waits).toHaveLength(1))
    expect(server.replies).toHaveLength(0)
    browser.runTimers()
    await vi.waitFor(() => expect(client.outbox.failures[0]?.error?.status).toBe(404))
    expect(server.replies).toHaveLength(1)
    await expect(client.outbox.dismiss(id)).resolves.toBe(true)
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

  it("shows a comment and tells onChange before the store has saved it", async () => {
    const { store, plan } = createSlowStore()
    const { server, client } = setup({ store })
    await vi.waitFor(() => expect(client.status).toBe("ready"))
    const write = gate()
    plan.push(write.promise)
    const changes = vi.fn()
    client.onChange(changes)
    const created = client.create({ subject, anchor, body: "Right away" })
    expect(changes).toHaveBeenCalled()
    expect(client.outbox.queued.map(entry => entry.input.body)).toEqual(["Right away"])
    expect(client.threads).toMatchObject([{ delivery: { status: "pending" }, messages: [{ body: "Right away", delivery: { status: "pending" } }] }])
    const thread = await created
    expect(client.threads.map(item => item.id)).toEqual([thread.id])
    expect(await store.list(ana.id)).toEqual([])
    write.open()
    await vi.waitFor(() => expect(client.outbox.entries).toHaveLength(0))
    expect(server.creates.map(input => input.body)).toEqual(["Right away"])
  })

  it("sends nothing when the store saves a comment after the client stopped", async () => {
    const { store, plan } = createSlowStore()
    const { server, client, stop } = setup({ store })
    await vi.waitFor(() => expect(client.status).toBe("ready"))
    const write = gate()
    plan.push(write.promise)
    await client.create({ subject, anchor, body: "Saved after the page left" })
    stop()
    write.open()
    await settle()
    expect(server.creates).toHaveLength(0)
    expect(await store.list(ana.id)).toMatchObject([{ input: { body: "Saved after the page left" } }])
  })

  it("keeps the order of the calls when the first write is slower", async () => {
    const { store, plan } = createSlowStore()
    const { server, client } = setup({ store })
    await vi.waitFor(() => expect(client.status).toBe("ready"))
    const write = gate()
    plan.push(write.promise)
    const first = client.create({ subject, anchor, body: "First", files: [new Blob(["a bigger file"])] })
    const second = client.create({ subject, anchor, body: "Second" })
    expect(client.outbox.entries.map(entry => entry.input.body)).toEqual(["First", "Second"])
    await second
    await settle()
    expect(server.creates).toHaveLength(0)
    write.open()
    await first
    await vi.waitFor(() => expect(client.outbox.entries).toHaveLength(0))
    expect(server.creates.map(input => input.body)).toEqual(["First", "Second"])
  })

  it("sends the next saved draft when the earlier write fails late", async () => {
    const { store, plan } = createSlowStore()
    const { server, client } = setup({ store })
    await vi.waitFor(() => expect(client.status).toBe("ready"))
    const write = deferred<void>()
    plan.push(write.promise)
    await client.create({ subject, anchor, body: "First" })
    await client.create({ subject, anchor, body: "Second" })
    await settle()
    expect(server.creates).toHaveLength(0)
    write.reject(new DOMException("Full", "QuotaExceededError"))
    await vi.waitFor(() => expect(server.creates.map(input => input.body)).toEqual(["Second"]))
    expect(client.outbox.failures.map(entry => entry.input.body)).toEqual(["First"])
  })

  it("does not restore a cleared draft when its delayed save finishes", async () => {
    const { store, plan } = createSlowStore()
    const { server, client } = setup({ store })
    await vi.waitFor(() => expect(client.status).toBe("ready"))
    const write = gate()
    plan.push(write.promise)
    await client.create({ subject, anchor, body: "Discard this" })
    await client.outbox.clear()
    write.open()
    await settle()
    expect(await store.list(ana.id)).toEqual([])
    expect(server.creates).toHaveLength(0)
  })

  it("warns before unload after an offline draft is saved in memory", async () => {
    const page = new EventTarget()
    vi.stubGlobal("addEventListener", page.addEventListener.bind(page))
    vi.stubGlobal("removeEventListener", page.removeEventListener.bind(page))
    const { browser, client, store } = setup()
    browser.online = false
    await client.create({ subject, anchor, body: "Only in memory" })
    await vi.waitFor(async () => expect(await store.list(ana.id)).toHaveLength(1))
    expect(page.dispatchEvent(new Event("beforeunload", { cancelable: true }))).toBe(false)
    await client.outbox.clear()
    expect(page.dispatchEvent(new Event("beforeunload", { cancelable: true }))).toBe(true)
  })

  it("resolves only after the previous reply reaches the server", async () => {
    const { server, client } = setup()
    const thread = await server.memory.create({ subject, anchor, body: "Open" })
    await client.refresh()
    const write = gate()
    server.plan.push(write.promise)
    await client.reply({ threadId: thread.id, body: "Before Resolve" })
    await vi.waitFor(() => expect(server.replies).toHaveLength(1))
    const resolved = client.resolve({ threadId: thread.id })
    await settle()
    expect((await server.memory.get({ threadId: thread.id }))?.status).toBe("open")
    write.open()
    expect(await resolved).toMatchObject({ status: "resolved", messages: [{ body: "Open" }, { body: "Before Resolve" }] })
  })

  it("returns the first draft on a replay before the other client's snapshot loads", async () => {
    const { browser, client, store, server } = setup()
    browser.online = false
    const first = await client.create({ subject, anchor, requestId: "one", body: "First body" })
    const other = setup({ browser, store, server }).client
    const replay = other.create({ subject, anchor, requestId: "one", body: "Other body" })
    const provisional = other.outbox.entries[0]?.id
    expect(provisional).toBeDefined()
    const reply = other.reply({ threadId: provisional!, requestId: "two", body: "A reply" })
    expect(await replay).toMatchObject({ id: first.id, messages: [{ body: "First body" }] })
    await reply
    await vi.waitFor(async () => expect(await store.list(ana.id)).toMatchObject([
      { id: first.id, input: { body: "First body" } },
      { input: { threadId: first.id, body: "A reply" } },
    ]))
    const third = setup({ browser, store, server }).client
    expect(await third.reply({ threadId: first.id, requestId: "two", body: "Ignore this replay" })).toMatchObject({
      id: first.id,
      messages: [{ body: "First body" }, { body: "A reply" }],
    })
  })

  it("retains deferred bytes when their checkpoint fails and sends them on retry", async () => {
    const { store, plan } = createSlowStore()
    const { server, client } = setup({ store })
    await vi.waitFor(() => expect(client.status).toBe("ready"))
    const files = deferred<Blob[]>()
    const draft = await client.create({ subject, anchor, body: "With picture", files: files.promise })
    await settle()
    plan.push(new DOMException("Full", "QuotaExceededError"))
    files.resolve([new Blob(["pixels"])])
    await vi.waitFor(() => expect(client.outbox.failures).toHaveLength(1))
    expect(server.creates).toHaveLength(0)
    await client.outbox.retry(draft.id)
    await vi.waitFor(() => expect(server.creates).toHaveLength(1))
    expect(await server.creates[0]!.files![0]!.text()).toBe("pixels")
  })

  it.each(["create", "reply"] as const)("keeps one tab's %s calls in order when another tab's write lands first", async (kind) => {
    const { store, plan } = createSerialStore()
    const browser = createBrowser()
    const server = createServer()
    const parent = await server.memory.create({ subject, anchor, body: "Parent" })
    const first = setup({ browser, server, store })
    const second = setup({ browser, server, store })
    await vi.waitFor(() => expect([first.client.status, second.client.status]).toEqual(["ready", "ready"]))
    const write = gate()
    plan.push(write.promise)
    const send = (client: typeof first.client, body: string) => kind === "create" ? client.create({ subject, anchor, body }) : client.reply({ threadId: parent.id, body })
    await send(second.client, "Other tab")
    await send(first.client, "One")
    await send(first.client, "Two")
    write.open()
    await vi.waitFor(() => expect(first.client.outbox.entries).toHaveLength(0))
    await vi.waitFor(() => expect(second.client.outbox.entries).toHaveLength(0))
    const sent = (kind === "create" ? server.creates : server.replies).map(input => input.body)
    expect(sent).toEqual(["Other tab", "One", "Two"])
  })

  it("keeps the replies of a comment whose save failed with it, and asks before the page leaves", async () => {
    const unload = new Set<EventListener>()
    vi.stubGlobal("addEventListener", (type: string, listener: EventListener) => type === "beforeunload" && unload.add(listener))
    vi.stubGlobal("removeEventListener", (type: string, listener: EventListener) => type === "beforeunload" && unload.delete(listener))
    const leave = () => {
      const event = new Event("beforeunload", { cancelable: true })
      for (const listener of unload) listener(event)
      return event.defaultPrevented
    }
    const { store, plan } = createSlowStore()
    const browser = createBrowser()
    const server = createServer()
    const { client, stop } = setup({ browser, server, store })
    await vi.waitFor(() => expect(client.status).toBe("ready"))
    plan.push(Object.assign(new Error("The disk is full."), { name: "QuotaExceededError" }))
    const thread = await client.create({ subject, anchor, body: "Wrong price" })
    await vi.waitFor(() => expect(client.outbox.failures).toHaveLength(1))
    const replied = await client.reply({ threadId: thread.id, body: "Yearly too" })
    expect(replied.messages.map(message => message.body)).toEqual(["Wrong price", "Yearly too"])
    await settle()
    expect(await store.list(ana.id)).toEqual([])

    const reloaded = setup({ browser, server, store })
    await vi.waitFor(() => expect(reloaded.client.status).toBe("ready"))
    await settle()
    expect(reloaded.client.outbox.entries).toEqual([])
    expect(server.replies).toHaveLength(0)
    reloaded.stop()

    stop()
    expect(leave()).toBe(true)
    stops.push(client.start())
    await client.outbox.retry(thread.id)
    await vi.waitFor(() => expect(server.memory.threads).toHaveLength(1))
    await vi.waitFor(() => expect(leave()).toBe(false))
    const [stored] = server.memory.threads
    expect(server.replies.map(input => input.threadId)).toEqual([stored!.id])
    expect(stored!.messages.map(message => message.body)).toEqual(["Wrong price", "Yearly too"])
  })

  it("keeps a comment whose save failed, and Retry saves and sends it", async () => {
    const { store, plan } = createSlowStore()
    const { server, client } = setup({ store })
    await vi.waitFor(() => expect(client.status).toBe("ready"))
    plan.push(Object.assign(new Error("The disk is full."), { name: "QuotaExceededError" }))
    const thread = await client.create({ subject, anchor, body: "Do not lose me", files: [new Blob(["pixels"])] })
    await vi.waitFor(() => expect(client.outbox.failures).toHaveLength(1))
    expect(client.outbox.failures[0]).toMatchObject({ id: thread.id, input: { body: "Do not lose me" }, error: { why: "The disk is full." } })
    expect(client.outbox.failures[0]!.files).toHaveLength(1)
    expect(client.threads).toMatchObject([{ id: thread.id, delivery: { status: "failed" } }])
    expect(await store.list(ana.id)).toEqual([])
    expect(server.creates).toHaveLength(0)

    await client.outbox.retry(thread.id)
    await vi.waitFor(() => expect(client.outbox.entries).toHaveLength(0))
    expect(server.creates.map(input => input.body)).toEqual(["Do not lose me"])
    expect(await server.creates[0]!.files![0]!.text()).toBe("pixels")
  })

  it("saves a comment whose files are on their way, and sends it once they arrive", async () => {
    const { server, client, store } = setup()
    await vi.waitFor(() => expect(client.status).toBe("ready"))
    let deliver!: (files: Blob[]) => void
    const files = new Promise<Blob[]>(resolve => deliver = resolve)
    const thread = await client.create({ subject, anchor, body: "Screenshot follows", files })
    expect(client.threads.map(item => item.id)).toEqual([thread.id])
    await vi.waitFor(async () => expect(await store.list(ana.id)).toMatchObject([{ input: { body: "Screenshot follows" } }]))
    await settle()
    expect(server.creates).toHaveLength(0)
    deliver([new Blob(["pixels"])])
    await vi.waitFor(() => expect(server.creates).toHaveLength(1))
    expect(await server.creates[0]!.files![0]!.text()).toBe("pixels")
    await vi.waitFor(() => expect(client.outbox.entries).toHaveLength(0))
  })

  it("sends without the files after a reload, or when they fail", async () => {
    const browser = createBrowser()
    const server = createServer()
    const store = createMemoryOutboxStore()
    const before = setup({ browser, server, store })
    await vi.waitFor(() => expect(before.client.status).toBe("ready"))
    await before.client.create({ subject, anchor, body: "The page went away", files: new Promise<Blob[]>(() => undefined) })
    await vi.waitFor(async () => expect(await store.list(ana.id)).toHaveLength(1))
    before.stop()

    const after = setup({ browser, server, store })
    await vi.waitFor(() => expect(server.creates).toHaveLength(1))
    expect(server.creates[0]).toMatchObject({ body: "The page went away" })
    expect(server.creates[0]!.files ?? []).toHaveLength(0)
    await vi.waitFor(() => expect(after.client.outbox.entries).toHaveLength(0))

    await after.client.create({ subject, anchor, body: "The screenshot failed", files: Promise.reject(new Error("No canvas")) })
    await vi.waitFor(() => expect(server.creates).toHaveLength(2))
    expect(server.creates[1]!.files ?? []).toHaveLength(0)
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
