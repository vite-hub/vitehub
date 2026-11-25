import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createCommentSend, createCommentSendTransport } from "../src/client.ts"

import type { CommentSendAgent, CommentSendEvent, CommentSendPairingCheck, CommentSendResult, CommentSendStatus, CommentSendTransport } from "../src/client.ts"

const t3: CommentSendAgent = { name: "T3 Code", logo: "t3", host: "relay.t3.codes" }
const prompt = "Connect this site's comments to this T3 thread. The code K7Q-4MX works once, for 10 minutes."

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function fakeTransport(status: CommentSendStatus, options: { push?: boolean } = {}) {
  let current = status
  const checks: CommentSendPairingCheck[] = []
  const results: CommentSendResult[] = []
  const calls: string[] = []
  const cancelled: string[] = []
  const selections: string[] = []
  let codes = 0
  let listener: ((event: CommentSendEvent) => void) | undefined
  const transport: CommentSendTransport = {
    status: async () => {
      calls.push("status")
      return current
    },
    startPairing: async () => {
      calls.push("startPairing")
      codes++
      return { code: `code-${codes}`, prompt, expiresAt: Date.now() + 10 * 60_000, agent: t3, count: current.count, selection: current.selection ?? "" }
    },
    pollPairing: async (code) => {
      calls.push(`pollPairing ${code}`)
      return checks.shift() ?? { status: "waiting" }
    },
    allow: async (code, selection) => {
      calls.push(`allow ${code}`)
      selections.push(selection)
      return results.shift()!
    },
    cancel: async (code) => {
      cancelled.push(code)
    },
    send: async () => {
      calls.push("send")
      return results.shift()!
    },
    ...(options.push ? { subscribe: (next: (event: CommentSendEvent) => void) => {
      listener = next
      return () => (listener = undefined)
    } } : {}),
  }
  return {
    transport,
    calls,
    cancelled,
    selections,
    checks,
    results,
    setStatus: (next: CommentSendStatus) => (current = next),
    push: (event: CommentSendEvent) => listener?.(event),
  }
}

const copied: string[] = []
const copy = async (text: Promise<string>) => {
  copied.push(await text)
  return true
}
const flush = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-11-19T15:00:00Z"))
  copied.length = 0
})
afterEach(() => vi.useRealTimers())

it("allows the code on the page that started pairing", async () => {
  let page = "/original"
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => Response.json({ data: { code: "paired-code" } }))
  const transport = createCommentSendTransport({ page: () => page, fetch })
  const pairing = await transport.startPairing()
  page = "/another-page"
  await transport.allow(pairing.code, "selection-1")
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    "/_vitehub/comments/send/start?page=%2Foriginal",
    "/_vitehub/comments/send/allow?page=%2Foriginal",
  ])
  expect(JSON.parse(String(fetch.mock.calls[1]![1]!.body))).toEqual({ code: "paired-code", selection: "selection-1" })
})

describe("createCommentSend", () => {
  it("polls queued deliveries even with pushed events and retries a dead batch", async () => {
    const server = fakeTransport({ count: 2, agent: t3 }, { push: true })
    const send = createCommentSend(server.transport)
    const stop = send.start()
    await flush()
    server.results.push({ status: "pending", id: "send-1" })
    await send.send()
    server.setStatus({ count: 2, agent: t3, pending: true })
    await vi.advanceTimersByTimeAsync(5000)
    expect(send.state.status).toBe("sending")

    server.setStatus({ count: 2, agent: t3 })
    await vi.advanceTimersByTimeAsync(5000)
    expect(send.state).toEqual({ status: "idle", count: 2, inbox: false, canPairAnother: true })
    server.results.push({ status: "sent", id: "send-2" })
    await send.send()
    expect(send.state.status).toBe("sent")
    stop()
  })

  it("ignores a failed queued delivery poll after the client stops", async () => {
    const server = fakeTransport({ count: 2, agent: t3 })
    const send = createCommentSend(server.transport)
    const stop = send.start()
    await flush()
    server.results.push({ status: "pending", id: "send-1" })
    await send.send()

    const poll = deferred<CommentSendStatus>()
    const status = vi.spyOn(server.transport, "status").mockReturnValueOnce(poll.promise)
    await vi.advanceTimersByTimeAsync(5000)
    expect(status).toHaveBeenCalledOnce()
    stop()
    poll.reject(new Error("Connection lost"))
    await flush()
    expect(send.state).toEqual({ status: "idle", count: 0, inbox: false })
  })

  it("walks all eight states: pairs in place, sends, works, and is done", async () => {
    const server = fakeTransport({ count: 2 })
    const send = createCommentSend(server.transport)
    const seen: string[] = []
    send.onChange(() => seen.at(-1) !== send.state.status && seen.push(send.state.status))
    const stop = send.start()
    await flush()
    expect(send.state).toEqual({ status: "idle", count: 2, inbox: false })

    await send.send(copy)
    expect(copied).toEqual([prompt])
    expect(send.state).toEqual({ status: "pairing", count: 2, prompt, expiresAt: Date.now() + 10 * 60_000, agent: t3 })

    server.checks.push({ status: "waiting" }, { status: "paired", agent: t3 })
    await vi.advanceTimersByTimeAsync(1500)
    expect(send.state.status).toBe("pairing")
    await vi.advanceTimersByTimeAsync(1500)
    expect(send.state).toEqual({ status: "confirm", count: 2, agent: t3 })

    server.results.push({ status: "sent", id: "send-1", thread: "https://app.t3.codes/threads/42" })
    const allowed = send.allow()
    expect(send.state).toEqual({ status: "sending", count: 2 })
    await allowed
    expect(server.calls).toContain("allow code-1")
    expect(send.state).toEqual({ status: "sent", count: 0, inbox: false })

    server.setStatus({ count: 0, agent: t3, working: { id: "send-1", thread: "https://app.t3.codes/threads/42" } })
    await vi.advanceTimersByTimeAsync(1999)
    expect(send.state.status).toBe("sent")
    await vi.advanceTimersByTimeAsync(1)
    expect(send.state).toEqual({ status: "working", count: 0, agent: t3, thread: "https://app.t3.codes/threads/42" })

    await vi.advanceTimersByTimeAsync(5000)
    expect(send.state.status).toBe("working")
    server.setStatus({ count: 0, agent: t3 })
    await vi.advanceTimersByTimeAsync(5000)
    expect(send.state).toEqual({ status: "idle", count: 0, inbox: false })

    server.setStatus({ count: 1, agent: t3 })
    await send.refresh()
    server.results.push({ status: "failed", reason: "The relay answered 502." })
    await send.send()
    expect(send.state).toEqual({ status: "failed", count: 1, reason: "The relay answered 502." })

    const retryAt = Date.now() + 10 * 60_000
    server.results.push({ status: "limited", retryAt })
    await send.send()
    expect(send.state).toEqual({ status: "limited", count: 1, retryAt })
    expect(server.calls.filter(call => call === "send")).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(send.state).toEqual({ status: "idle", count: 1, inbox: false, canPairAnother: true })

    expect(seen).toEqual(["idle", "pairing", "confirm", "sending", "sent", "working", "idle", "sending", "failed", "sending", "limited", "idle"])
    stop()
  })

  it("says when the setup code expired, and Copy again gets a new one", async () => {
    const server = fakeTransport({ count: 3 })
    const send = createCommentSend(server.transport)
    send.start()
    await flush()
    await send.send(copy)
    server.checks.push({ status: "expired" })
    await vi.advanceTimersByTimeAsync(1500)
    expect(send.state).toMatchObject({ status: "pairing", reason: "expired", count: 3 })

    const asked = server.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(server.calls).toHaveLength(asked)

    await send.copyAgain(copy)
    expect(copied).toEqual([prompt, prompt])
    expect(server.cancelled).toEqual(["code-1"])
    expect(send.state).toMatchObject({ status: "pairing", count: 3 })
    expect(send.state).not.toHaveProperty("reason")
  })

  it("calls a code expired at its expiry time, without asking the server", async () => {
    const server = fakeTransport({ count: 1 })
    const send = createCommentSend(server.transport)
    send.start()
    await flush()
    await send.send(copy)
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1500)
    expect(send.state).toMatchObject({ status: "pairing", reason: "expired" })
  })

  it("refuses an agent URL on another host, and Copy again starts over", async () => {
    const server = fakeTransport({ count: 2 })
    const send = createCommentSend(server.transport)
    send.start()
    await flush()
    await send.send(copy)
    server.checks.push({ status: "refused" })
    await vi.advanceTimersByTimeAsync(1500)
    expect(send.state).toMatchObject({ status: "pairing", reason: "refused", agent: t3 })

    await send.allow()
    expect(server.calls.some(call => call.startsWith("allow"))).toBe(false)

    await send.copyAgain(copy)
    server.checks.push({ status: "paired", agent: t3 })
    await vi.advanceTimersByTimeAsync(1500)
    expect(send.state).toEqual({ status: "confirm", count: 2, agent: t3 })
    expect(server.calls).toContain("pollPairing code-2")
  })

  it("cancels pairing with ×, drops the code, and sends nothing", async () => {
    const server = fakeTransport({ count: 2 })
    const send = createCommentSend(server.transport)
    send.start()
    await flush()
    await send.send(copy)
    server.checks.push({ status: "paired", agent: t3 })
    await vi.advanceTimersByTimeAsync(1500)
    send.cancel()
    expect(send.state).toEqual({ status: "idle", count: 2, inbox: false })
    expect(server.cancelled).toEqual(["code-1"])
    await send.send(copy)
    expect(send.state.status).toBe("pairing")
  })

  it("does not pair when the browser refuses the clipboard", async () => {
    const server = fakeTransport({ count: 2 })
    const send = createCommentSend(server.transport)
    send.start()
    await flush()
    await send.send(async () => false)
    expect(send.state).toMatchObject({ status: "failed", count: 2 })
    expect(server.cancelled).toEqual(["code-1"])
  })

  it("keeps a working push during the Sent hold when status is unavailable", async () => {
    const server = fakeTransport({ count: 1, agent: t3 }, { push: true })
    const send = createCommentSend(server.transport)
    const stop = send.start()
    await flush()
    server.results.push({ status: "sent", id: "send-1" })
    await send.send()
    server.transport.status = async () => { throw new Error("Status unavailable") }
    const thread = "https://app.t3.codes/threads/42"
    server.push({ type: "working", id: "send-1", thread })
    expect(send.state.status).toBe("sent")
    await vi.advanceTimersByTimeAsync(2000)
    expect(send.state).toMatchObject({ status: "working", thread })
    stop()
  })

  it("sends at once to a paired agent, and follows pushed events", async () => {
    const server = fakeTransport({ count: 2, agent: t3 }, { push: true })
    const send = createCommentSend(server.transport)
    send.start()
    await flush()
    server.results.push({ status: "sent", id: "send-1" })
    server.setStatus({ count: 0, agent: t3, sent: { id: "send-1" } })
    await send.send(copy)
    expect(copied).toEqual([])
    expect(server.calls).not.toContain("startPairing")
    await vi.advanceTimersByTimeAsync(2000)
    expect(send.state).toEqual({ status: "sent", count: 0, inbox: false })

    server.push({ type: "working", id: "send-1", thread: "https://app.t3.codes/threads/42" })
    server.push({ type: "count", count: 1 })
    expect(send.state).toEqual({ status: "working", count: 1, agent: t3, thread: "https://app.t3.codes/threads/42" })

    server.setStatus({ count: 1, agent: t3 })
    server.push({ type: "done", id: "send-0" })
    await flush()
    expect(send.state.status).toBe("working")
    server.push({ type: "done", id: "send-1" })
    await flush()
    expect(send.state).toEqual({ status: "idle", count: 1, inbox: false, canPairAnother: true })
  })

  it("allows only the threads that the member saw, and confirms the new ones after a change", async () => {
    const server = fakeTransport({ count: 2, selection: "two" })
    const send = createCommentSend(server.transport)
    send.start()
    await flush()
    await send.send(copy)
    server.checks.push({ status: "paired", agent: t3 })
    await vi.advanceTimersByTimeAsync(1500)
    expect(send.state).toEqual({ status: "confirm", count: 2, agent: t3 })
    server.results.push({ status: "changed", count: 3, selection: "three" })
    await send.allow()
    expect(send.state).toEqual({ status: "confirm", count: 3, agent: t3 })
    expect(server.cancelled).toEqual([])
    server.results.push({ status: "sent", id: "send-1" })
    await send.allow()
    expect(server.calls.filter(call => call.startsWith("allow"))).toEqual(["allow code-1", "allow code-1"])
    expect(server.selections).toEqual(["two", "three"])
    expect(send.state).toEqual({ status: "sent", count: 0, inbox: false })
  })

  it("loads the selection again when the count changes while the member pairs", async () => {
    const server = fakeTransport({ count: 1, selection: "one" }, { push: true })
    const send = createCommentSend(server.transport)
    send.start()
    await flush()
    await send.send(copy)
    expect(send.state).toMatchObject({ status: "pairing", count: 1 })
    server.setStatus({ count: 2, selection: "two" })
    server.push({ type: "count", count: 2 })
    await flush()
    expect(send.state).toMatchObject({ status: "pairing", count: 2 })
    server.checks.push({ status: "paired", agent: t3 })
    await vi.advanceTimersByTimeAsync(1500)
    server.results.push({ status: "sent", id: "send-1" })
    await send.allow()
    expect(server.selections).toEqual(["two"])
  })

  it("starts a second pairing without sending to the existing agent", async () => {
    const server = fakeTransport({ count: 0, agent: t3 }, { push: true })
    const send = createCommentSend(server.transport)
    const stop = send.start()
    await flush()
    server.push({ type: "count", count: 2 })
    expect(send.state).toMatchObject({ status: "idle", count: 2, canPairAnother: true })
    await send.pairAnother(copy)
    expect(copied).toEqual([prompt])
    expect(server.calls).not.toContain("send")
    server.checks.push({ status: "paired", agent: t3 })
    await vi.advanceTimersByTimeAsync(1500)
    server.results.push({ status: "sent", id: "send-2" })
    await send.allow()
    expect(server.calls).toContain("allow code-1")
    stop()
  })

  it("shows the agent's send on load, a limit on load, and an inbox", async () => {
    const working = createCommentSend(fakeTransport({ count: 0, agent: t3, working: { id: "send-1" } }).transport)
    working.start()
    const limited = createCommentSend(fakeTransport({ count: 4, agent: t3, retryAt: Date.now() + 60_000 }).transport)
    limited.start()
    const inbox = createCommentSend(fakeTransport({ count: 3, agent: { name: "Claude Code", logo: "claude" } }).transport)
    inbox.start()
    await flush()
    expect(working.state).toEqual({ status: "working", count: 0, agent: t3 })
    expect(limited.state).toEqual({ status: "limited", count: 4, retryAt: Date.now() + 60_000 })
    expect(inbox.state).toEqual({ status: "idle", count: 3, inbox: true, canPairAnother: true })
  })

  it("keeps In inbox until the agent reads the send, and sends a new comment from there", async () => {
    const claude: CommentSendAgent = { name: "Claude Code", logo: "claude" }
    const server = fakeTransport({ count: 2, agent: claude })
    const send = createCommentSend(server.transport)
    send.start()
    await flush()
    server.results.push({ status: "sent", id: "send-1" })
    server.setStatus({ count: 0, agent: claude, sent: { id: "send-1" } })
    await send.send()
    await vi.advanceTimersByTimeAsync(2000)
    expect(send.state).toEqual({ status: "sent", count: 0, inbox: true })
    await vi.advanceTimersByTimeAsync(5000)
    expect(send.state).toEqual({ status: "sent", count: 0, inbox: true })

    server.setStatus({ count: 1, agent: claude, sent: { id: "send-1" } })
    await send.refresh()
    expect(send.state).toEqual({ status: "sent", count: 1, inbox: true })
    server.results.push({ status: "sent", id: "send-2" })
    await send.send()
    expect(server.calls.filter(call => call === "send")).toHaveLength(2)

    server.setStatus({ count: 0, agent: claude, working: { id: "send-2" } })
    await vi.advanceTimersByTimeAsync(2000)
    expect(send.state).toEqual({ status: "working", count: 0, agent: claude })
  })

  it("shows a send that the agent has not read on load", async () => {
    const send = createCommentSend(fakeTransport({ count: 0, agent: t3, sent: { id: "send-1" } }).transport)
    send.start()
    await flush()
    expect(send.state).toEqual({ status: "sent", count: 0, inbox: false })
  })

  it.each(["pairing", "confirm", "sending"])("reconciles server status after stopping in %s", async (interrupted) => {
    const server = fakeTransport({ count: 2 })
    const delivery = deferred<CommentSendResult>()
    server.transport.allow = () => delivery.promise
    const send = createCommentSend(server.transport)
    const stop = send.start()
    await flush()
    await send.send(copy)
    if (interrupted !== "pairing") {
      server.checks.push({ status: "paired", agent: t3 })
      await vi.advanceTimersByTimeAsync(1500)
    }
    const allowing = interrupted === "sending" ? send.allow() : undefined
    expect(send.state.status).toBe(interrupted)
    stop()

    server.setStatus({ count: 3, agent: t3 })
    send.start()
    await flush()
    delivery.resolve({ status: "sent", id: "old-send" })
    await allowing
    expect(send.state).toEqual({ status: "idle", count: 3, inbox: false, canPairAnother: true })
    expect(server.cancelled).toEqual(interrupted === "sending" ? [] : ["code-1"])
  })

  it("keeps a pairing press when a stale status succeeds", async () => {
    const server = fakeTransport({ count: 2 })
    const send = createCommentSend(server.transport)
    send.start()
    await flush()
    const load = deferred<CommentSendStatus>()
    server.transport.status = () => load.promise
    const refreshing = send.refresh()
    const setup = deferred<void>()
    const startPairing = server.transport.startPairing
    server.transport.startPairing = async () => {
      await setup.promise
      return startPairing()
    }
    const pairing = send.send(copy)
    load.resolve({ count: 0 })
    await refreshing
    setup.resolve()
    await pairing
    expect(send.state).toMatchObject({ status: "pairing", count: 2 })
    expect(copied).toEqual([prompt])
    expect(server.cancelled).toEqual([])
  })

  it("keeps a second send when a stale Working poll rejects", async () => {
    const server = fakeTransport({ count: 1, agent: t3, working: { id: "old" } })
    const send = createCommentSend(server.transport)
    send.start()
    await flush()
    const load = deferred<CommentSendStatus>()
    server.transport.status = () => load.promise
    await vi.advanceTimersByTimeAsync(5000)
    const delivery = deferred<CommentSendResult>()
    server.transport.send = () => delivery.promise
    const sending = send.send()
    load.reject(new Error("Offline"))
    await flush()
    expect(send.state.status).toBe("sending")
    delivery.resolve({ status: "sent", id: "new" })
    await sending
    expect(send.state.status).toBe("sent")
  })

  it.each([false, true])("reconciles pushes before delivery responds (done: %s)", async (done) => {
    const server = fakeTransport({ count: 2, agent: t3 }, { push: true })
    const delivery = deferred<CommentSendResult>()
    server.transport.send = () => delivery.promise
    const send = createCommentSend(server.transport)
    send.start()
    await flush()
    const sending = send.send()
    const thread = "https://app.t3.codes/threads/42"
    server.push({ type: "working", id: "new", thread })
    server.push({ type: "working", id: "old", thread: "https://app.t3.codes/threads/41" })
    server.push({ type: "done", id: "old" })
    if (done) server.push({ type: "done", id: "new" })
    server.push({ type: "count", count: 1 })
    delivery.resolve({ status: "sent", id: "new" })
    await sending
    expect(send.state).toMatchObject({ status: "sent", count: 1 })
    await vi.advanceTimersByTimeAsync(2000)
    expect(send.state).toEqual(done
      ? { status: "idle", count: 1, inbox: false, canPairAnother: true }
      : { status: "working", count: 1, agent: t3, thread })
  })

  it("keeps a pushed count when an earlier status response arrives", async () => {
    const server = fakeTransport({ count: 2, agent: t3 }, { push: true })
    const load = deferred<CommentSendStatus>()
    server.transport.status = () => load.promise
    const send = createCommentSend(server.transport)
    send.start()
    server.push({ type: "count", count: 3 })
    load.resolve({ count: 2, agent: t3 })
    await flush()
    expect(send.state).toEqual({ status: "idle", count: 3, inbox: false, canPairAnother: true })
  })

  it("handles setup failure even when the clipboard awaits the prompt", async () => {
    const server = fakeTransport({ count: 2 })
    server.transport.startPairing = async () => {
      throw new Error("Setup unavailable")
    }
    const send = createCommentSend(server.transport)
    send.start()
    await flush()
    await send.send(copy)
    expect(send.state).toEqual({ status: "failed", count: 2, reason: "Setup unavailable" })
  })

  it("keeps Send hidden with nothing to send, and turns a thrown send into Not delivered", async () => {
    const server = fakeTransport({ count: 0, agent: t3 })
    server.transport.send = async () => {
      throw new Error("Failed to fetch")
    }
    const send = createCommentSend(server.transport)
    send.start()
    await flush()
    await send.send()
    expect(send.state).toEqual({ status: "idle", count: 0, inbox: false })
    server.setStatus({ count: 2, agent: t3 })
    await send.refresh()
    await send.send()
    expect(send.state).toEqual({ status: "failed", count: 2, reason: "Failed to fetch" })
  })
})
