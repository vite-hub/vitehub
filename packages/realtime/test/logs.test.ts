import { afterEach, describe, expect, it, vi } from "vitest"

import * as Y from "yjs"

import { setEvlogBridge } from "@vite-hub/internal/runtime/request-log"

import { logRealtime } from "../src/log.ts"
import { encodeWorkspaceChange } from "../src/protocol.ts"
import { createRealtimeHandler, refreshRealtimeDocument } from "../src/server.ts"
import { appendParagraph, createMemoryAdapter, createMemoryBusNetwork, createStubEditor, createTestServer, FakeSql, settle } from "./harness.ts"

import type { RealtimeHandlerOptions } from "../src/server.ts"
import type { RealtimeDefinition } from "../src/types.ts"

afterEach(() => {
  setEvlogBridge(undefined)
  vi.restoreAllMocks()
})

const app = "https://app.example"

function requestLogger(path?: string) {
  const fields = { path }
  return { fields, set: vi.fn((update: Record<string, unknown>) => { Object.assign(fields, update) }), warn: vi.fn(), error: vi.fn() }
}

function fakeEvlog() {
  const enabled = { value: true }
  const events: Array<{ fields: Record<string, unknown>, info: ReturnType<typeof vi.fn>, error: ReturnType<typeof vi.fn>, warn: ReturnType<typeof vi.fn>, emit: ReturnType<typeof vi.fn> }> = []
  const createLogger = (fields: Record<string, unknown>) => {
    const logger = { fields, info: vi.fn(), error: vi.fn(), warn: vi.fn(), emit: vi.fn() }
    events.push(logger)
    return logger
  }
  setEvlogBridge({ createLogger, isEnabled: () => enabled.value })
  return { enabled, events }
}

type Hooks = {
  error(peer: object, error: unknown): void
  message(peer: object, message: { uint8Array(): Uint8Array }): void
  open(peer: object): void
}

function server(definition: Partial<RealtimeDefinition>, options?: RealtimeHandlerOptions) {
  const { adapter } = createMemoryAdapter({ "guides/welcome.md": { body: "Welcome" } })
  // SAFETY: Each test passes the access fields that a Definition needs.
  const docs = { document: adapter, ...definition } as RealtimeDefinition
  const handler = createRealtimeHandler({ docs: async () => ({ default: docs }) } as never, options)
  return (path: string, init: { origin?: string, log?: ReturnType<typeof requestLogger>, method?: string, body?: ArrayBuffer } = {}) => {
    const request = new Request(`${app}/api/_vitehub/realtime/docs/${path}`, {
      body: init.body,
      method: init.method,
      headers: init.method ? { origin: init.origin ?? app } : { upgrade: "websocket", ...init.origin ? { origin: init.origin } : {} },
    })
    if (init.log) Object.assign(request, { context: { log: init.log } })
    return handler.fetch(request) as Promise<Response & { crossws?: Hooks }>
  }
}

function peer() {
  return { id: crypto.randomUUID(), close: vi.fn(), publish: vi.fn(), send: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() }
}

function realtimeFields(log: ReturnType<typeof requestLogger>): unknown[] {
  return log.set.mock.calls.map(([fields]) => fields).filter(fields => "realtime" in fields).map(fields => fields.realtime)
}

describe("Realtime refusals on the upgrade request's wide event", () => {
  it("sets an origin refusal", async () => {
    const log = requestLogger()
    const response = await server({ access: "public" })("guides/welcome.md", { origin: "https://evil.example", log })

    expect(response.status).toBe(403)
    expect(realtimeFields(log)).toEqual([{ definition: "docs", room: "guides/welcome.md", refused: "origin", status: 403 }])
    expect(log.error).not.toHaveBeenCalled()
  })

  it("sets a refusal when authorize() returns false", async () => {
    const log = requestLogger()
    const response = await server({ authorize: () => false })("guides/welcome.md", { log })

    expect(response.status).toBe(401)
    expect(realtimeFields(log)).toEqual([{ definition: "docs", room: "guides/welcome.md", refused: "authorize", status: 401 }])
    expect(log.error).not.toHaveBeenCalled()
  })

  it("sets a refusal and logs the error when authorize() throws, also to the console", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    const log = requestLogger()
    const failure = new Error("The permissions table is not reachable.")
    const response = await server({ authorize: () => { throw failure } })("guides/welcome.md", { log })

    expect(response.status).toBe(500)
    expect(realtimeFields(log)).toEqual([{ definition: "docs", room: "guides/welcome.md", refused: "authorize", status: 500 }])
    expect(log.error).toHaveBeenCalledExactlyOnceWith("Realtime refused a connection.")
    expect(consoleError).toHaveBeenCalledWith("[vitehub] Realtime refused a connection.", expect.objectContaining({ refused: "authorize", status: 500 }), failure)
  })

  it("logs a thrown authorize() to the console without evlog", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    const failure = new Error("The permissions table is not reachable.")
    const response = await server({ authorize: () => { throw failure } })("guides/welcome.md")

    expect(response.status).toBe(500)
    expect(consoleError).toHaveBeenCalledWith("[vitehub] Realtime refused a connection.", { definition: "docs", room: "guides/welcome.md", refused: "authorize", status: 500 }, failure)
  })

  it("hashes the room of a Definition without a document, whose id can be a token", async () => {
    const token = "0b6c8f9e-2f6d-4d2a-9a51-7f1f3c0e1d2a"
    const log = requestLogger(`/api/_vitehub/realtime/docs/tabs/${token}`)
    await server({ document: false, authorize: () => false })(`tabs/${token}`, { log })

    const [fields] = realtimeFields(log) as Array<{ room: string }>
    expect(fields).toMatchObject({ definition: "docs", refused: "authorize", status: 401 })
    expect(fields!.room).toMatch(/^#[0-9a-f]{8}$/)
    expect(JSON.stringify(log.fields)).not.toContain(token)
  })

  it("does not print a presence room URL from an upgrade error", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    const token = "private-room-upgrade"
    const response = await server({ document: false, authorize: ({ request }) => { throw new Error(`Could not authorize ${request.url}`) } })(token)

    expect(response.status).toBe(500)
    expect(consoleError).toHaveBeenCalledExactlyOnceWith("[vitehub] Realtime refused a connection.", {
      definition: "docs", room: expect.stringMatching(/^#[0-9a-f]{8}$/), refused: "authorize", status: 500,
    })
  })

  it("records the response status and diagnostic code for an unsynchronized save", async () => {
    const log = requestLogger()
    const client = new Y.Doc()
    try {
      appendParagraph(client, "Unsynchronized edit")
      const response = await server({ access: "public", editor: createStubEditor().editor })("guides/welcome.md?document=save", {
        body: Uint8Array.from(Y.encodeStateAsUpdate(client)).buffer,
        method: "POST",
        log,
      })
      expect(response.status).toBe(409)
      await expect(response.json()).resolves.toMatchObject({ data: { code: "REALTIME_SYNC_PENDING" } })
      expect(realtimeFields(log)).toEqual([{ definition: "docs", room: "guides/welcome.md", refused: "error", status: 409, code: "REALTIME_SYNC_PENDING" }])
    }
    finally {
      client.destroy()
    }
  })

  it("uses H3's HTTP status for a legacy statusCode without changing the response", async () => {
    const log = requestLogger()
    const error = Object.assign(new Error("Unavailable"), { statusCode: 503 })
    const response = await server({ authorize: () => { throw error } })("guides/welcome.md?document=save", { method: "POST", log })

    expect(response.status).toBe(503)
    expect(realtimeFields(log)).toEqual([{ definition: "docs", room: "guides/welcome.md", refused: "authorize", status: 503 }])
  })

  it("sets a refusal of a document request", async () => {
    const log = requestLogger()
    const response = await server({ identify: () => ({ id: "writer" }), authorize: ({ mode }) => mode === "read" })("guides/welcome.md?document=save", { method: "POST", log })

    expect(response.status).toBe(403)
    expect(realtimeFields(log)).toEqual([{ definition: "docs", room: "guides/welcome.md", refused: "authorize", status: 403 }])
  })
})

describe("Realtime log events after the upgrade", () => {
  it("logs a peer error as an evlog event", async () => {
    const evlog = fakeEvlog()
    const response = await server({ access: "public" })("guides/welcome.md", { log: requestLogger() })
    const client = peer()
    response.crossws!.open(client)
    const failure = new Error("The socket was reset.")

    response.crossws!.error(client, failure)
    await settle()
    expect(evlog.events).toHaveLength(1)

    expect(evlog.events[0]!.fields).toEqual({
      action: "realtime",
      message: "A Realtime connection failed.",
      realtime: { definition: "docs", room: "guides/welcome.md", failed: "peer" },
    })
    expect(evlog.events[0]!.error).toHaveBeenCalledWith("A Realtime connection failed.")
    expect(evlog.events[0]!.emit).toHaveBeenCalledOnce()
  })

  it("logs a 4429 close as an evlog event", async () => {
    vi.spyOn(Date, "now").mockReturnValue(100)
    const evlog = fakeEvlog()
    const response = await server({ access: "public" })("%40workspace?workspace=events", { log: requestLogger() })
    const client = peer()
    response.crossws!.open(client)

    for (let index = 0; index <= 100; index++) {
      response.crossws!.message(client, { uint8Array: () => encodeWorkspaceChange({ operation: "create", path: `${index}.md` }) })
    }
    await settle()
    expect(evlog.events).toHaveLength(1)

    expect(client.close).toHaveBeenCalledWith(4429, "Workspace change rate limit exceeded.")
    expect(evlog.events[0]!.fields).toEqual({
      action: "realtime",
      message: "Workspace change rate limit exceeded.",
      realtime: { definition: "docs", room: "@workspace", closed: 4429 },
    })
    expect(evlog.events[0]!.warn).toHaveBeenCalledWith("Workspace change rate limit exceeded.")
  })

  it("changes nothing without evlog, and never throws when evlog fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {})
    for (const broken of [false, true]) {
      if (broken) setEvlogBridge({ createLogger: () => { throw new Error("evlog is broken") } })
      const response = await server({ access: "public" })("guides/welcome.md", { log: broken ? requestLogger() : undefined })
      const client = peer()
      response.crossws!.open(client)

      expect(() => response.crossws!.message(client, { uint8Array: () => new Uint8Array([0xFF]) })).not.toThrow()
      expect(() => response.crossws!.error(client, new Error("The socket was reset."))).not.toThrow()
      await settle()
      expect(client.close).toHaveBeenCalledWith(4400, "Invalid realtime message.")
    }
    expect(consoleError).not.toHaveBeenCalled()
    expect(consoleWarn).not.toHaveBeenCalled()
  })
})

describe("Realtime log events: one per failure, and none lost", () => {
  it.each(["save", "release"] as const)("logs a failed last-peer %s before disposing a Durable Object room", async (failed) => {
    const evlog = fakeEvlog()
    const { adapter } = createMemoryAdapter({ page: { body: "Start" } })
    const hold = vi.fn().mockResolvedValue(undefined)
    const release = vi.fn().mockRejectedValue(new Error("Release unavailable"))
    adapter.save.mockRejectedValue(new Error("Store unavailable"))
    const document = failed === "release" ? { ...adapter, hold, release } : adapter
    const app = createTestServer({ access: "public", document, editor: createStubEditor().editor }, { durable: new FakeSql() })
    const client = await app.connect("page")
    await settle()
    if (failed === "save") appendParagraph(client.doc, "Unsaved edit")
    client.close()
    client.doc.destroy()
    await settle()

    expect(failed === "save" ? adapter.save : release).toHaveBeenCalledOnce()
    expect(evlog.events.map(event => event.fields.realtime)).toEqual([
      { definition: "docs", room: "page", failed },
    ])
  })

  it("reports a failed Durable Object refresh but not a successful no-op", async () => {
    const evlog = fakeEvlog()
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(Response.json({ reseeded: false }))
    const durableObjects = { idFromName: () => ({}), get: () => ({ fetch }) }

    await expect(refreshRealtimeDocument("docs", "page", { durableObjects })).resolves.toBe(false)
    await expect(refreshRealtimeDocument("docs", "page", { durableObjects })).resolves.toBe(false)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(evlog.events.map(event => event.fields.realtime)).toEqual([
      { definition: "docs", room: expect.stringMatching(/^#[0-9a-f]{8}$/), failed: "refresh", status: 500 },
    ])
  })

  it("does not print an unverified room URL from a failed refresh fetch", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const fetch = vi.fn(async (request: Request) => { throw new Error(`Could not fetch ${request.url}`) })
    const durableObjects = { idFromName: () => ({}), get: () => ({ fetch }) }

    await expect(refreshRealtimeDocument("docs", "private-room-refresh", { durableObjects })).resolves.toBe(false)
    expect(consoleWarn).toHaveBeenCalledExactlyOnceWith("[vitehub] Realtime could not refresh an open room.", {
      definition: "docs", room: expect.stringMatching(/^#[0-9a-f]{8}$/), failed: "refresh",
    })
  })

  it("does not log an unverified room ID in a failed refresh fan-out", async () => {
    const evlog = fakeEvlog()
    const bus = createMemoryBusNetwork().bus()
    const publish = vi.spyOn(bus, "publish")
    const connect = server({ access: "public", document: false }, { bus: () => bus })
    const token = "synthetic-presence-id-for-a-refresh"

    const client = peer()
    const hooks = (await connect(token)).crossws!
    hooks.open(client)
    await settle()
    publish.mockClear().mockRejectedValue(new Error("Bus unavailable"))
    await expect(refreshRealtimeDocument("docs", token)).resolves.toBe(false)
    const failures = evlog.events.filter(event => (event.fields.realtime as { failed: string }).failed === "bus-publish")
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: "refresh" }))
    expect(failures).not.toHaveLength(0)
    expect(JSON.stringify(failures.map(event => event.fields))).not.toContain(token)
  })

  it("logs separate failed operations that share the same error object", () => {
    const evlog = fakeEvlog()
    const error = new Error("Redis retries exhausted")
    for (const room of ["first", "second"]) {
      logRealtime("warn", "Realtime could not renew a room lock.", { definition: "docs", room, failed: "bus-lock" }, error)
    }
    expect(evlog.events.map(event => event.fields.realtime)).toEqual([
      { definition: "docs", room: "first", failed: "bus-lock" },
      { definition: "docs", room: "second", failed: "bus-lock" },
    ])
  })

  it("logs one close for a connection that keeps sending bad frames, and drops its frames", async () => {
    vi.spyOn(Date, "now").mockReturnValue(100)
    const evlog = fakeEvlog()
    const connect = server({ access: "public" })
    const bad = (await connect("guides/welcome.md", { log: requestLogger() })).crossws!
    const badPeer = peer()
    bad.open(badPeer)
    for (let index = 0; index < 50; index++) bad.message(badPeer, { uint8Array: () => new Uint8Array([0xFF]) })

    const burst = (await connect("%40workspace?workspace=events", { log: requestLogger() })).crossws!
    const burstPeer = peer()
    burst.open(burstPeer)
    for (let index = 0; index < 150; index++) {
      burst.message(burstPeer, { uint8Array: () => encodeWorkspaceChange({ operation: "create", path: `${index}.md` }) })
    }
    await settle()

    expect(badPeer.close).toHaveBeenCalledOnce()
    expect(burstPeer.close).toHaveBeenCalledOnce()
    expect(burstPeer.publish).toHaveBeenCalledTimes(100)
    expect(evlog.events.map(event => (event.fields.realtime as { closed: number }).closed)).toEqual([4400, 4429])
  })

  it("sends an error to evlog only, and prints to the console when evlog is off", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const evlog = fakeEvlog()
    const failure = Object.assign(new Error("connect ECONNREFUSED redis://admin:hunter2@cache.internal:6379"), { code: "ECONNREFUSED" })

    logRealtime("error", "Realtime could not send a room message to the other instances.", { definition: "docs", failed: "bus-publish" }, failure)
    expect(evlog.events).toHaveLength(1)
    expect(evlog.events[0]!.fields).toEqual({ action: "realtime", message: "Realtime could not send a room message to the other instances.", realtime: { definition: "docs", failed: "bus-publish", code: "ECONNREFUSED" } })
    expect(evlog.events[0]!.error).toHaveBeenCalledWith("Realtime could not send a room message to the other instances.")
    expect(JSON.stringify([evlog.events[0]!.fields, evlog.events[0]!.error.mock.calls])).not.toContain("hunter2")
    expect(consoleError).not.toHaveBeenCalled()

    evlog.enabled.value = false
    logRealtime("warn", "Realtime could not save a room.", { definition: "docs", failed: "save" }, new Error("Store unavailable"))
    expect(consoleWarn).toHaveBeenCalledWith("[vitehub] Realtime could not save a room.", "Store unavailable")
    expect(evlog.events).toHaveLength(1)
  })

  it("leaves a failed shared-record write of a request to the request's own log", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    const evlog = fakeEvlog()
    const network = createMemoryBusNetwork()
    const bus = network.bus()
    const { adapter } = createMemoryAdapter({ page: { body: "Start" } })
    const app = createTestServer({ access: "public", document: adapter, editor: createStubEditor().editor, persistence: false }, { handler: { bus: () => bus } })
    const client = await app.connect("page")
    await settle()
    vi.spyOn(bus, "writeRoom").mockRejectedValue(new Error("Record unavailable"))

    appendParagraph(client.doc, "Saved")
    await settle()
    expect((await app.post("page", "save", { state: Y.encodeStateAsUpdate(client.doc) })).status).toBe(500)
    await settle()

    expect(evlog.events).toEqual([])
    expect(consoleError).not.toHaveBeenCalledWith("[vitehub] Realtime could not write the shared room record.", expect.anything())
  })
})
