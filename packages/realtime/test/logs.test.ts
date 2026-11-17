import { afterEach, describe, expect, it, vi } from "vitest"

import { resetRealtimeEvlog } from "../src/log.ts"
import { encodeWorkspaceChange } from "../src/protocol.ts"
import { createRealtimeHandler } from "../src/server.ts"
import { createMemoryAdapter, settle } from "./harness.ts"

import type { RealtimeHandlerOptions } from "../src/server.ts"
import type { RealtimeDefinition } from "../src/types.ts"

afterEach(() => {
  resetRealtimeEvlog()
  vi.restoreAllMocks()
})

const app = "https://app.example"

/** evlog's request logger, where evlog's Nitro plugin puts it. */
function requestLogger() {
  return { set: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

/** `import("evlog")`: each event's logger is kept, so a test can read what it logged. */
function fakeEvlog() {
  const events: Array<{ fields: Record<string, unknown>, error: ReturnType<typeof vi.fn>, warn: ReturnType<typeof vi.fn>, emit: ReturnType<typeof vi.fn> }> = []
  const createLogger = (fields: Record<string, unknown>) => {
    const logger = { fields, error: vi.fn(), warn: vi.fn(), emit: vi.fn() }
    events.push(logger)
    return logger
  }
  return { events, load: async () => ({ createLogger }) }
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
  return (path: string, init: { origin?: string, log?: ReturnType<typeof requestLogger>, method?: string } = {}) => {
    const request = new Request(`${app}/api/_vitehub/realtime/docs/${path}`, {
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

    expect(response.status).toBe(403)
    expect(realtimeFields(log)).toEqual([{ definition: "docs", room: "guides/welcome.md", refused: "authorize", status: 403 }])
    expect(log.error).not.toHaveBeenCalled()
  })

  it("sets a refusal and logs the error when authorize() throws", async () => {
    const log = requestLogger()
    const failure = new Error("The permissions table is not reachable.")
    const response = await server({ authorize: () => { throw failure } })("guides/welcome.md", { log })

    expect(response.status).toBe(500)
    expect(realtimeFields(log)).toEqual([{ definition: "docs", room: "guides/welcome.md", refused: "authorize", status: 500 }])
    expect(log.error).toHaveBeenCalledWith(failure)
  })

  it("logs a thrown authorize() to the console without evlog", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    const failure = new Error("The permissions table is not reachable.")
    const response = await server({ authorize: () => { throw failure } })("guides/welcome.md")

    expect(response.status).toBe(500)
    expect(consoleError).toHaveBeenCalledWith("[vitehub] Realtime refused a connection.", failure)
  })

  it("hashes the room of a Definition without a document, whose id can be a token", async () => {
    const log = requestLogger()
    await server({ document: false, authorize: () => false })("tabs/0b6c8f9e-2f6d-4d2a-9a51-7f1f3c0e1d2a", { log })

    const [fields] = realtimeFields(log) as Array<{ room: string }>
    expect(fields).toMatchObject({ definition: "docs", refused: "authorize", status: 403 })
    expect(fields!.room).toMatch(/^#[0-9a-f]{8}$/)
  })

  it("sets a refusal of a document request", async () => {
    const log = requestLogger()
    const response = await server({ authorize: ({ mode }) => mode === "read" })("guides/welcome.md?document=save", { method: "POST", log })

    expect(response.status).toBe(403)
    expect(realtimeFields(log)).toEqual([{ definition: "docs", room: "guides/welcome.md", refused: "authorize", status: 403 }])
  })
})

describe("Realtime log events after the upgrade", () => {
  it("logs a peer error as an evlog event", async () => {
    const evlog = fakeEvlog()
    const response = await server({ access: "public" }, { evlog: evlog.load })("guides/welcome.md", { log: requestLogger() })
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
    expect(evlog.events[0]!.error).toHaveBeenCalledWith(failure)
    expect(evlog.events[0]!.emit).toHaveBeenCalledOnce()
  })

  it("logs a 4429 close as an evlog event", async () => {
    vi.spyOn(Date, "now").mockReturnValue(100)
    const evlog = fakeEvlog()
    const response = await server({ access: "public" }, { evlog: evlog.load })("%40workspace?workspace=events", { log: requestLogger() })
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
    const broken = async () => ({ createLogger: () => { throw new Error("evlog is broken") } })
    for (const options of [undefined, { evlog: broken }, { evlog: async () => { throw new Error("evlog is not installed") } }]) {
      resetRealtimeEvlog()
      const response = await server({ access: "public" }, options)("guides/welcome.md", { log: options ? requestLogger() : undefined })
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

  it("skips evlog when the app's requests have no evlog request logger", async () => {
    const evlog = fakeEvlog()
    const response = await server({ access: "public" }, { evlog: evlog.load })("guides/welcome.md")
    const client = peer()
    response.crossws!.open(client)

    response.crossws!.error(client, new Error("The socket was reset."))
    await settle()

    expect(evlog.events).toHaveLength(0)
  })
})
