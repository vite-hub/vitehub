import { beforeEach, describe, expect, it, vi } from "vitest"

interface TeamsThread { conversationId: string, serviceUrl: string }

const store = vi.hoisted(() => new Map<string, unknown>())

vi.mock("@vite-hub/kv", () => ({
  kv: {
    get: async (key: string) => [null, store.get(key) ?? null],
    set: async (key: string, value: unknown) => {
      store.set(key, value)
      return [null, undefined]
    },
  },
}))

function encode(thread: TeamsThread): string {
  return `teams:${Buffer.from(thread.conversationId).toString("base64url")}:${Buffer.from(thread.serviceUrl).toString("base64url")}`
}

function decode(threadId: string): TeamsThread {
  const [, conversationId = "", serviceUrl = ""] = threadId.split(":")
  return { conversationId: Buffer.from(conversationId, "base64url").toString(), serviceUrl: Buffer.from(serviceUrl, "base64url").toString() }
}

function createAdapter() {
  let next = 100
  return {
    decodeThreadId: vi.fn(decode),
    encodeThreadId: vi.fn(encode),
    openDM: vi.fn(async (userId: string) => encode({ conversationId: `a:${userId}`, serviceUrl: "https://smba.example" })),
    // The Teams adapter before chat 4.42 returns the channel ID instead of the root thread ID.
    postChannelMessage: vi.fn(async (channelId: string) => ({ id: String(next++), raw: {}, threadId: channelId })),
    postMessage: vi.fn(async (threadId: string) => ({ id: String(next++), raw: {}, threadId })),
  }
}

const channel = encode({ conversationId: "19:general@thread.tacv2", serviceUrl: "https://smba.example" })

beforeEach(() => {
  store.clear()
})

async function setup() {
  const adapter = createAdapter()
  const { teams } = await import("../src/channels.ts")
  // SAFETY: The fake implements the Teams adapter methods that the connector calls.
  return { adapter, connector: teams.connector({ adapter: adapter as never }) }
}

describe("teams.connector()", () => {
  it("posts to a thread and opens direct messages for user recipients", async () => {
    const { adapter, connector } = await setup()
    await expect(connector.send("Hello", { recipient: channel })).resolves.toEqual({ id: "100" })
    await expect(connector.send("Hi", { recipient: "user:29:abc" })).resolves.toEqual({ id: "101" })
    expect(adapter.openDM).toHaveBeenCalledWith("29:abc")
    expect(adapter.postMessage).toHaveBeenLastCalledWith(encode({ conversationId: "a:29:abc", serviceUrl: "https://smba.example" }), { markdown: "Hi" })
  })

  it("returns the stored receipt for a repeated idempotency key", async () => {
    const { adapter, connector } = await setup()
    const results = await Promise.all([
      connector.send("Once", { recipient: channel, idempotencyKey: "event-1" }),
      connector.send("Once", { recipient: channel, idempotencyKey: "event-1" }),
    ])
    expect(results).toEqual([{ id: "100" }, { id: "100" }])
    expect(adapter.postMessage).toHaveBeenCalledOnce()
  })

  it("creates one root per thread key and replies under it", async () => {
    const { adapter, connector } = await setup()
    const thread = { key: "ticket:1", root: "**Ticket 1**" }
    const [first, second] = await Promise.all([
      connector.send("First", { recipient: channel, thread, idempotencyKey: "m1" }),
      connector.send("Second", { recipient: channel, thread, idempotencyKey: "m2" }),
    ])
    await expect(connector.send("First", { recipient: channel, thread, idempotencyKey: "m1" })).resolves.toEqual(first)
    expect(adapter.postChannelMessage).toHaveBeenCalledOnce()
    expect(adapter.postChannelMessage).toHaveBeenCalledWith(channel, { markdown: "**Ticket 1**" })
    const rootThread = encode({ conversationId: "19:general@thread.tacv2;messageid=100", serviceUrl: "https://smba.example" })
    expect(adapter.postMessage.mock.calls).toEqual([[rootThread, { markdown: "First" }], [rootThread, { markdown: "Second" }]])
    expect([first, second]).toEqual([{ id: "101" }, { id: "102" }])
  })

  it("uses the first text as the root when the thread has no root text", async () => {
    const { adapter, connector } = await setup()
    await expect(connector.send("Opening", { recipient: channel, thread: { key: "topic" } })).resolves.toEqual({ id: "100" })
    await expect(connector.send("Follow-up", { recipient: channel, thread: { key: "topic" } })).resolves.toEqual({ id: "101" })
    expect(adapter.postChannelMessage).toHaveBeenCalledOnce()
    expect(adapter.postMessage).toHaveBeenCalledOnce()
  })

  it("rejects a thread for a recipient that is not a channel", async () => {
    const { connector } = await setup()
    const reply = encode({ conversationId: "19:general@thread.tacv2;messageid=5", serviceUrl: "https://smba.example" })
    await expect(connector.send("x", { recipient: reply, thread: { key: "k" } })).rejects.toThrow("channel recipient without a message ID")
    await expect(connector.send("x", { recipient: "user:1", thread: { key: "k" } })).rejects.toThrow("channel recipient without a message ID")
    // SAFETY: The test checks the runtime guard for an untyped caller.
    await expect(connector.send("x", { recipient: "" } as never)).rejects.toThrow("requires a recipient")
  })

  it("builds the adapter from Server Env when options are omitted", async () => {
    vi.resetModules()
    const createTeamsAdapter = vi.fn(() => createAdapter())
    vi.doMock("@chat-adapter/teams", () => ({ createTeamsAdapter }))
    vi.doMock("#vitehub/env/server", () => ({ useServerEnv: () => ({ teams: { appId: "app-id", appPassword: "secret", appTenantId: "tenant" } }) }))
    try {
      const { teams } = await import("../src/channels.ts")
      const teamsConnector = teams.connector({ adapter: { userName: "Bot" } })
      await teamsConnector.send("a", { recipient: channel })
      await teamsConnector.send("b", { recipient: channel })
      expect(createTeamsAdapter).toHaveBeenCalledOnce()
      expect(createTeamsAdapter).toHaveBeenCalledWith({ appId: "app-id", appPassword: "secret", appTenantId: "tenant", userName: "Bot" })
    }
    finally {
      vi.doUnmock("@chat-adapter/teams")
      vi.doUnmock("#vitehub/env/server")
      vi.resetModules()
    }
  })
})
